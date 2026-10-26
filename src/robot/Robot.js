import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Kinematics } from './Kinematics.js';

const DEG = Math.PI / 180;
// Tiempo de aceleración 0 → velocidad máxima (datasheet IRB 14050: 0,12 s para 0-1 m/s).
const ACCEL_TIME = 0.12;
// Velocidad de reorientación de la herramienta en movimientos lineales.
const TOOL_ROT_SPEED = 180 * DEG;
// Muestreo de las trayectorias cartesianas.
const PATH_DT = 0.01;

/**
 * Robot articulado cargado desde public/robots/<id>/.
 * Cada eslabón cuelga de un pivote situado sobre su eje; girar el pivote mueve toda la cadena.
 * Ángulos internos en radianes; la API pública trabaja en grados como un FlexPendant.
 * Las poses cartesianas están en el marco de la base del robot (metros, Y arriba).
 */
export class Robot {
  static async load(id) {
    const base = `/robots/${id}/`;
    const spec = await (await fetch(base + 'robot.json')).json();
    const kin = await (await fetch(base + spec.kinematics)).json();
    const gltf = await new GLTFLoader().loadAsync(base + spec.model);
    return new Robot(spec, kin, gltf.scene);
  }

  constructor(spec, kinJson, gltfScene) {
    this.spec = spec;
    this.kin = new Kinematics(kinJson, spec);
    this.root = new THREE.Group();
    this.root.name = spec.id;
    this.speedOverride = 1;
    this.maxTcpSpeed = spec.specs.max_tcp_velocity_mps;

    // Agrupa las mallas del GLB por eslabón (nombres "<eslabón>__<n>").
    const meshesByNode = {};
    gltfScene.traverse((o) => {
      if (!o.isMesh) return;
      const node = o.name.split('__')[0];
      (meshesByNode[node] ??= []).push(o);
      o.castShadow = true;
      o.receiveShadow = true;
    });
    const attach = (node, parent, offset) => {
      const g = new THREE.Group();
      g.name = node;
      g.position.copy(offset);
      for (const m of meshesByNode[node] ?? []) {
        m.removeFromParent();
        m.position.set(0, 0, 0);
        m.rotation.set(0, 0, 0);
        g.add(m);
      }
      parent.add(g);
      return g;
    };

    attach('base', this.root, new THREE.Vector3());
    this.joints = [];
    let parent = this.root;
    let prevOrigin = new THREE.Vector3();
    for (const [i, j] of kinJson.joints.entries()) {
      const k = this.kin.joints[i];
      const pivot = new THREE.Group();
      pivot.name = j.name;
      pivot.position.copy(k.origin).sub(prevOrigin);
      parent.add(pivot);
      const link = attach(j.child, pivot, k.origin.clone().negate());
      this.joints.push({ ...k, label: spec.joints[j.name].label, pivot, link, q: 0 });
      parent = pivot;
      prevOrigin = k.origin;
    }

    // Herramienta: cuelga del último eslabón; los dedos se desplazan sobre su eje.
    const flangeLink = this.joints.at(-1).link;
    this.fingers = [];
    if (kinJson.tool) {
      attach('gripper', flangeLink, new THREE.Vector3());
      const axis = new THREE.Vector3(...kinJson.tool.finger_axis);
      for (const [node, sign] of [['finger_l', -1], ['finger_r', 1]]) {
        const g = attach(node, flangeLink, new THREE.Vector3());
        this.fingers.push({ group: g, dir: axis.clone().multiplyScalar(sign) });
      }
    }
    this.gripper = { opening: 0, target: 0, stroke: spec.gripper?.finger_stroke_m ?? 0, speed: spec.gripper?.finger_speed_mps ?? 0.025 };

    this.move = null; // movimiento activo: articular ('joint') o trayectoria muestreada ('path')
    this.jogTarget = this.joints.map(() => 0);
    this.listeners = new Set();
  }

  get dof() {
    return this.joints.length;
  }

  get q() {
    return this.joints.map((j) => j.q);
  }

  get busy() {
    return this.move !== null;
  }

  getJointsDeg() {
    return this.joints.map((j) => j.q / DEG);
  }

  /** Coloca el robot instantáneamente (sin dinámica). */
  setJointsDeg(values) {
    values.forEach((v, i) => this._apply(i, v * DEG));
    this.jogTarget = this.q;
    this.move = null;
  }

  clampDeg(i, v) {
    const j = this.joints[i];
    return THREE.MathUtils.clamp(v, j.min / DEG, j.max / DEG);
  }

  /** Jog de un eje: el robot persigue el objetivo respetando la velocidad máxima del eje. */
  jogDeg(i, v) {
    this._cancel();
    this.jogTarget[i] = this.clampDeg(i, v) * DEG;
  }

  /** Pose actual del TCP en el marco de la base. */
  getTcpPose() {
    const { position, quaternion } = this.kin.forward(this.q);
    return { position, quaternion };
  }

  /**
   * Movimiento articular sincronizado (como MoveAbsJ): todos los ejes llegan a la vez,
   * con perfil trapezoidal limitado por la velocidad máxima de cada eje y el override.
   * Devuelve una promesa que se resuelve al llegar.
   */
  moveJ(targetDeg) {
    return this._moveJRad(targetDeg.map((v, i) => this.clampDeg(i, v) * DEG));
  }

  goHome() {
    return this.moveJ(this.joints.map((j) => this.spec.home_deg?.[j.name] ?? 0));
  }

  /** MoveJ hacia una pose cartesiana: resuelve la IK y mueve en espacio articular. */
  async moveJTo(pose) {
    const r = this.kin.inverse(pose, this.q);
    if (!r.ok) return { ok: false, reason: 'Fuera de alcance' };
    await this._moveJRad(r.q);
    return { ok: true };
  }

  /**
   * MoveL: el TCP sigue una recta (y la orientación una interpolación esférica) con perfil
   * trapezoidal. Si algún eje superara su velocidad máxima, se alarga la duración.
   */
  async moveL(pose, speed = 0.25) {
    const plan = this.planLinear(pose, speed);
    if (!plan.ok) return plan;
    await this._play(plan.path, PATH_DT);
    return { ok: true, duration: plan.duration };
  }

  planLinear(pose, speed = 0.25) {
    const start = this.getTcpPose();
    const dist = start.position.distanceTo(pose.position);
    const angle = start.quaternion.angleTo(pose.quaternion);
    const v = Math.min(speed, this.maxTcpSpeed) * this.speedOverride;
    let cruise = Math.max(dist / v, angle / (TOOL_ROT_SPEED * this.speedOverride));
    if (cruise === 0) return { ok: true, path: [this.q], duration: 0 };

    // Hasta 3 intentos: si la articulación más exigida supera su límite, se estira el tiempo.
    for (let attempt = 0; attempt < 3; attempt++) {
      const ta = Math.min(ACCEL_TIME, cruise);
      const T = cruise + ta;
      const steps = Math.max(1, Math.ceil(T / PATH_DT));
      const path = [this.q];
      let q = this.q;
      let ratio = 0;
      const p = new THREE.Vector3();
      const r = new THREE.Quaternion();
      for (let k = 1; k <= steps; k++) {
        const s = trapezoid(Math.min(k * PATH_DT, T), T, ta);
        p.lerpVectors(start.position, pose.position, s);
        r.slerpQuaternions(start.quaternion, pose.quaternion, s);
        const sol = this.kin.track({ position: p, quaternion: r }, q);
        if (!sol.ok) return { ok: false, reason: 'La trayectoria lineal sale del alcance o cruza una singularidad' };
        sol.q.forEach((qi, i) => {
          ratio = Math.max(ratio, Math.abs(qi - q[i]) / PATH_DT / (this.joints[i].vmax * this.speedOverride));
        });
        q = sol.q;
        path.push(q);
      }
      if (ratio <= 1.001) return { ok: true, path, duration: T };
      if (ratio > 50) return { ok: false, reason: 'La trayectoria lineal pasa por una singularidad' };
      cruise *= ratio * 1.05;
    }
    return { ok: false, reason: 'No se encontró una velocidad articular válida' };
  }

  /** 0 = cerrada, 1 = abierta del todo. */
  setGripper(opening) {
    this.gripper.target = THREE.MathUtils.clamp(opening, 0, 1);
  }

  /** Detiene el movimiento en curso (la promesa pendiente se resuelve). */
  stop() {
    this._cancel();
    this.jogTarget = this.q;
  }

  update(dt) {
    const m = this.move;
    if (m) {
      m.t = Math.min(m.t + dt, m.duration);
      if (m.kind === 'joint') {
        const s = trapezoid(m.t, m.duration, m.ta);
        m.start.forEach((q0, i) => this._apply(i, q0 + (m.goal[i] - q0) * s));
      } else {
        const f = m.t / m.dt;
        const k = Math.min(Math.floor(f), m.path.length - 1);
        const a = m.path[k];
        const b = m.path[Math.min(k + 1, m.path.length - 1)];
        const w = f - k;
        a.forEach((qa, i) => this._apply(i, qa + (b[i] - qa) * w));
      }
      if (m.t >= m.duration) this._finish();
    } else {
      this.joints.forEach((j, i) => {
        const step = j.vmax * this.speedOverride * dt;
        const d = THREE.MathUtils.clamp(this.jogTarget[i] - j.q, -step, step);
        if (d) this._apply(i, j.q + d);
      });
    }

    const g = this.gripper;
    if (g.opening !== g.target && g.stroke) {
      const step = (g.speed / g.stroke) * dt;
      g.opening += THREE.MathUtils.clamp(g.target - g.opening, -step, step);
      for (const f of this.fingers) f.group.position.copy(f.dir).multiplyScalar(g.opening * g.stroke);
    }
    this.listeners.forEach((fn) => fn(this));
  }

  onUpdate(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _moveJRad(goal) {
    this._cancel();
    const start = this.q;
    let cruise = 0;
    goal.forEach((g, i) => {
      cruise = Math.max(cruise, Math.abs(g - start[i]) / (this.joints[i].vmax * this.speedOverride));
    });
    const ta = Math.min(ACCEL_TIME, cruise);
    return new Promise((resolve) => {
      this.move = { kind: 'joint', start, goal, t: 0, duration: cruise + ta, ta, resolve };
      if (cruise === 0) this._finish();
    });
  }

  _play(path, dt) {
    this._cancel();
    return new Promise((resolve) => {
      this.move = { kind: 'path', path, dt, t: 0, duration: (path.length - 1) * dt, resolve };
      if (path.length < 2) this._finish();
    });
  }

  _finish() {
    const m = this.move;
    const goal = m.kind === 'joint' ? m.goal : m.path.at(-1);
    goal.forEach((q, i) => this._apply(i, q));
    this.jogTarget = [...goal];
    this.move = null;
    m.resolve();
  }

  _cancel() {
    if (!this.move) return;
    const m = this.move;
    this.move = null;
    m.resolve();
  }

  _apply(i, q) {
    const j = this.joints[i];
    j.q = THREE.MathUtils.clamp(q, j.min, j.max);
    j.pivot.quaternion.setFromAxisAngle(j.axis, j.q);
  }
}

/** Fracción recorrida [0,1] de un perfil de velocidad trapezoidal de duración T y rampa ta. */
function trapezoid(t, T, ta) {
  if (T <= 0) return 1;
  if (ta <= 0) return t / T;
  const v = 1 / (T - ta); // velocidad de crucero normalizada
  if (t < ta) return (0.5 * v * t * t) / ta;
  if (t > T - ta) {
    const r = T - t;
    return 1 - (0.5 * v * r * r) / ta;
  }
  return v * (t - ta / 2);
}
