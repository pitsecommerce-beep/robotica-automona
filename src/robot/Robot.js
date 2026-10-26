import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const DEG = Math.PI / 180;
// Tiempo de aceleración 0 → velocidad máxima (datasheet IRB 14050: 0,12 s para 0-1 m/s).
const ACCEL_TIME = 0.12;

/**
 * Robot articulado cargado desde public/robots/<id>/.
 * Cada eslabón cuelga de un pivote situado sobre su eje; girar el pivote mueve toda la cadena.
 * Ángulos internos en radianes; la API pública trabaja en grados como un FlexPendant.
 */
export class Robot {
  static async load(id) {
    const base = `/robots/${id}/`;
    const spec = await (await fetch(base + 'robot.json')).json();
    const kin = await (await fetch(base + spec.kinematics)).json();
    const gltf = await new GLTFLoader().loadAsync(base + spec.model);
    return new Robot(spec, kin, gltf.scene);
  }

  constructor(spec, kin, gltfScene) {
    this.spec = spec;
    this.kin = kin;
    this.root = new THREE.Group();
    this.root.name = spec.id;
    this.speedOverride = 1;

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
    for (const j of kin.joints) {
      const origin = new THREE.Vector3(...j.origin);
      const pivot = new THREE.Group();
      pivot.name = j.name;
      pivot.position.copy(origin).sub(prevOrigin);
      parent.add(pivot);
      const link = attach(j.child, pivot, origin.clone().negate());
      const lim = spec.joints[j.name];
      this.joints.push({
        name: j.name,
        label: lim.label,
        axis: new THREE.Vector3(...j.axis).normalize(),
        min: lim.min_deg * DEG,
        max: lim.max_deg * DEG,
        vmax: lim.max_speed_dps * DEG,
        pivot,
        link,
        origin,
        q: 0,
      });
      parent = pivot;
      prevOrigin = origin;
    }

    // Herramienta: cuelga del último eslabón; los dedos se desplazan sobre su eje.
    const last = this.joints.at(-1);
    const flangeLink = last.link;
    this.fingers = [];
    if (kin.tool) {
      attach('gripper', flangeLink, new THREE.Vector3());
      const axis = new THREE.Vector3(...kin.tool.finger_axis);
      for (const [node, sign] of [['finger_l', -1], ['finger_r', 1]]) {
        const g = attach(node, flangeLink, new THREE.Vector3());
        this.fingers.push({ group: g, dir: axis.clone().multiplyScalar(sign) });
      }
      this.tcp = new THREE.Object3D();
      this.tcp.position.set(...kin.tool.tcp);
      flangeLink.add(this.tcp);
    }
    this.gripper = { opening: 0, target: 0, stroke: spec.gripper?.finger_stroke_m ?? 0, speed: spec.gripper?.finger_speed_mps ?? 0.025 };

    this.move = null; // trayectoria articular activa
    this.jogTarget = this.joints.map(() => 0);
    this.listeners = new Set();
  }

  get dof() {
    return this.joints.length;
  }

  getJointsDeg() {
    return this.joints.map((j) => j.q / DEG);
  }

  /** Coloca el robot instantáneamente (sin dinámica). */
  setJointsDeg(values) {
    values.forEach((v, i) => this._apply(i, v * DEG));
    this.jogTarget = this.joints.map((j) => j.q);
    this.move = null;
  }

  clampDeg(i, v) {
    const j = this.joints[i];
    return THREE.MathUtils.clamp(v, j.min / DEG, j.max / DEG);
  }

  /** Jog de un eje: el robot persigue el objetivo respetando la velocidad máxima del eje. */
  jogDeg(i, v) {
    this.move = null;
    this.jogTarget[i] = this.clampDeg(i, v) * DEG;
  }

  /**
   * Movimiento articular sincronizado (como MoveAbsJ): todos los ejes llegan a la vez,
   * con perfil trapezoidal limitado por la velocidad máxima de cada eje y el override.
   * Devuelve una promesa que se resuelve al llegar.
   */
  moveJ(targetDeg) {
    const start = this.joints.map((j) => j.q);
    const goal = targetDeg.map((v, i) => this.clampDeg(i, v) * DEG);
    const vscale = this.speedOverride;
    let cruise = 0;
    goal.forEach((g, i) => {
      cruise = Math.max(cruise, Math.abs(g - start[i]) / (this.joints[i].vmax * vscale));
    });
    const ta = Math.min(ACCEL_TIME, cruise);
    const duration = cruise + ta;
    return new Promise((resolve) => {
      this.move = { start, goal, t: 0, duration, ta, resolve };
      if (duration === 0) this._finishMove();
    });
  }

  goHome() {
    return this.moveJ(this.joints.map((j) => this.spec.home_deg?.[j.name] ?? 0));
  }

  /** 0 = cerrada, 1 = abierta del todo. */
  setGripper(opening) {
    this.gripper.target = THREE.MathUtils.clamp(opening, 0, 1);
  }

  update(dt) {
    if (this.move) {
      const m = this.move;
      m.t = Math.min(m.t + dt, m.duration);
      const s = trapezoid(m.t, m.duration, m.ta);
      m.start.forEach((q0, i) => this._apply(i, q0 + (m.goal[i] - q0) * s));
      if (m.t >= m.duration) this._finishMove();
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

  /** Posición del TCP en mm respecto a la base del robot. */
  getTcpMm() {
    if (!this.tcp) return null;
    this.root.updateMatrixWorld(true);
    const p = this.tcp.getWorldPosition(new THREE.Vector3());
    this.root.worldToLocal(p);
    return p.multiplyScalar(1000);
  }

  _finishMove() {
    const m = this.move;
    m.goal.forEach((q, i) => this._apply(i, q));
    this.jogTarget = [...m.goal];
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
