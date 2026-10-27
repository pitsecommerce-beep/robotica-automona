import * as THREE from 'three';
import { toolDown } from '../robot/Kinematics.js';

export const COLORS = {
  rojo: 0xe0262c,
  azul: 0x1f6fd1,
  verde: 0x1f9e4f,
  amarillo: 0xf2c200,
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Base de los escenarios: objetos con física, destinos, reglas de clasificación (por color o
 * SKU) y el ciclo pick & place. Las subclases construyen la celda y deciden qué recoger.
 */
export class Scenario {
  constructor({ lab, robot, physics, onEvent }) {
    this.lab = lab;
    this.robot = robot;
    this.physics = physics;
    this.onEvent = onEvent ?? (() => {});
    this.group = new THREE.Group();
    lab.scene.add(this.group);
    this.destinations = []; // { id, label, color?, sku?, slots(), count }
    this.rules = new Map(); // valor (color o SKU) → id de destino
    this.sortBy = 'color';
    this.running = false;
    this.paused = false;
    this.held = null;
    this.stats = { done: 0, rejected: 0 };
    this.speed = 0.3;
    this._unsub = robot.onUpdate(() => this._followTool());
  }

  /** Punto en el marco de la base del robot → mundo. */
  toWorld(x, y, z) {
    return this.robot.root.localToWorld(new THREE.Vector3(x, y, z));
  }

  toRobot(v) {
    return this.robot.root.worldToLocal(new THREE.Vector3(v.x, v.y, v.z));
  }

  emit(type, data = {}) {
    this.onEvent({ type, ...data });
  }

  // ------------------------------------------------------------------ reglas

  destinationFor(item) {
    const key = this.sortBy === 'sku' ? item.sku : item.color;
    const id = this.rules.get(key);
    return this.destinations.find((d) => d.id === id) ?? null;
  }

  setRule(match, destinationId) {
    const dest = this.findDestination(destinationId);
    if (!dest) return { ok: false, reason: `No existe el destino «${destinationId}»` };
    const key = normalize(match);
    if (Object.keys(COLORS).includes(key)) this.sortBy = 'color';
    else this.sortBy = 'sku';
    this.rules.set(this.sortBy === 'sku' ? match.toUpperCase() : key, dest.id);
    this.emit('rules');
    return { ok: true };
  }

  resetRules() {
    this.rules = new Map(this.defaultRules());
    this.sortBy = 'color';
    this.emit('rules');
  }

  setSortBy(mode) {
    this.sortBy = mode;
    this.rules = new Map(mode === 'sku' ? this.defaultSkuRules() : this.defaultRules());
    this.emit('rules');
  }

  findDestination(text) {
    if (!text) return null;
    const t = normalize(text);
    return (
      this.destinations.find((d) => normalize(d.id) === t || normalize(d.label) === t) ??
      this.destinations.find((d) => t.includes(normalize(d.id)) || normalize(d.label).includes(t) || (d.color && t.includes(d.color)))
    );
  }

  defaultRules() {
    return this.destinations.filter((d) => d.color).map((d) => [d.color, d.id]);
  }

  defaultSkuRules() {
    return this.destinations.filter((d) => d.sku).map((d) => [d.sku, d.id]);
  }

  // ------------------------------------------------------------------ ciclo

  start() {
    if (this.running) return;
    this.running = true;
    this.emit('status', { running: true });
    this._loop().catch((err) => {
      console.error(err);
      this.running = false;
      this.emit('error', { message: err.message });
    });
  }

  stop() {
    this.running = false;
    this.emit('status', { running: false });
  }

  async _loop() {
    while (this.running) {
      const item = await this.nextItem();
      if (!this.running) break;
      if (!item) {
        await wait(200);
        continue;
      }
      const dest = this.destinationFor(item);
      if (!dest) {
        this.emit('skip', { item, reason: `No hay regla para ${this.sortBy === 'sku' ? item.sku : item.color}` });
        await this.skipItem(item);
        continue;
      }
      if (item.mass > this.robot.spec.specs.payload_kg) {
        this.stats.rejected++;
        this.emit('overload', { item });
        await this.skipItem(item);
        continue;
      }
      const r = await this.pickPlace(item, dest);
      if (!r.ok) {
        this.emit('error', { message: r.reason });
        this.stop();
      }
    }
    if (!this.held) await this.robot.goHome();
  }

  /** Recoge el objeto y lo deja en el siguiente hueco del destino. */
  async pickPlace(item, dest) {
    const robot = this.robot;
    const top = this.toRobot(item.mesh.position).add(new THREE.Vector3(0, item.half.y, 0));
    const yaw = itemYaw(item);
    const grasp = top.clone().add(new THREE.Vector3(0, -this.graspDepth(item), 0));
    const clearance = this.clearance;
    const above = grasp.clone().setY(Math.max(grasp.y + clearance, this.safeHeight));

    this.emit('pick', { item, dest });
    let r = await robot.moveJTo({ position: above, quaternion: toolDown(yaw) });
    if (!r.ok) return r;
    await this.openTool(item);
    r = await robot.moveL({ position: grasp, quaternion: toolDown(yaw) }, this.speed * 0.5, { fallbackToJoint: true });
    if (!r.ok) return r;
    await this.closeTool(item);
    this.attach(item);
    r = await robot.moveL({ position: above, quaternion: toolDown(yaw) }, this.speed, { fallbackToJoint: true });
    if (!r.ok) return r;

    const slot = dest.nextSlot(item); // { position (base del objeto, marco robot), yaw }
    const placeTcp = slot.position.clone().add(new THREE.Vector3(0, 2 * item.half.y - this.graspDepth(item) + 0.004, 0));
    const placeAbove = placeTcp.clone().setY(Math.max(placeTcp.y + clearance, this.safeHeight));
    r = await robot.moveJTo({ position: placeAbove, quaternion: toolDown(slot.yaw) });
    if (!r.ok) return r;
    r = await robot.moveL({ position: placeTcp, quaternion: toolDown(slot.yaw) }, this.speed * 0.5, { fallbackToJoint: true });
    if (!r.ok) return r;
    this.detach();
    await this.openTool(item);
    dest.count++;
    this.stats.done++;
    this.emit('placed', { item, dest });
    r = await robot.moveL({ position: placeAbove, quaternion: toolDown(slot.yaw) }, this.speed, { fallbackToJoint: true });
    return r;
  }

  attach(item) {
    const tcp = this.robot.getTcpWorld();
    item.mesh.updateMatrixWorld();
    const inv = new THREE.Matrix4().compose(tcp.position, tcp.quaternion, new THREE.Vector3(1, 1, 1)).invert();
    item.offset = inv.multiply(item.mesh.matrixWorld.clone());
    this.physics.grab(item);
    this.held = item;
  }

  detach() {
    if (!this.held) return;
    this.physics.release(this.held);
    this.held = null;
  }

  _followTool() {
    if (!this.held) return;
    const tcp = this.robot.getTcpWorld();
    const m = new THREE.Matrix4().compose(tcp.position, tcp.quaternion, new THREE.Vector3(1, 1, 1)).multiply(this.held.offset);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    m.decompose(p, q, new THREE.Vector3());
    this.physics.moveHeld(this.held, p, q);
  }

  /** Estado resumido para el cerebro (Claude) y la interfaz. */
  describe() {
    const items = [...this.physics.items].filter((i) => !i.gone);
    return {
      scenario: this.id,
      title: this.title,
      robot: { name: this.robot.spec.name, payload_kg: this.robot.spec.specs.payload_kg, reach_m: this.robot.spec.specs.reach_m },
      running: this.running,
      sort_by: this.sortBy,
      rules: Object.fromEntries(this.rules),
      destinations: this.destinations.map((d) => ({ id: d.id, label: d.label, color: d.color ?? null, sku: d.sku ?? null, count: d.count })),
      items: items.slice(0, 30).map((i) => ({ id: i.id, color: i.color, sku: i.sku, mass_kg: +i.mass.toFixed(2) })),
      stats: this.stats,
    };
  }

  update(dt) {}

  dispose() {
    this.running = false;
    this._unsub();
    this.detach();
    for (const item of [...this.physics.items]) this.physics.removeItem(item);
    this.group.removeFromParent();
  }

  // --- a definir por cada escenario
  async nextItem() {
    return null;
  }

  async skipItem() {}

  graspDepth() {
    return 0;
  }

  async openTool() {}

  async closeTool() {}
}

export function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

/** Giro del objeto sobre la vertical, en grados, reducido a ±45° (cajas simétricas a 90°). */
export function itemYaw(item) {
  const e = new THREE.Euler().setFromQuaternion(item.mesh.quaternion, 'YXZ');
  let deg = THREE.MathUtils.radToDeg(e.y);
  deg = ((((deg + 45) % 90) + 90) % 90) - 45;
  return deg;
}

/** Caja con color y etiqueta impresa (SKU). */
export function makeBoxMesh(size, color, label) {
  const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
  const base = new THREE.MeshStandardMaterial({ color, roughness: 0.65 });
  const mats = [base, base, base, base, base, base];
  if (label) {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = `#${new THREE.Color(color).getHexString()}`;
    g.fillRect(0, 0, 256, 128);
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.fillRect(16, 24, 224, 80);
    g.fillStyle = '#111';
    g.font = 'bold 40px Inter, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, 128, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const labelMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 });
    mats[2] = labelMat; // cara superior
    mats[0] = labelMat; // lateral +X
  }
  const mesh = new THREE.Mesh(geo, mats);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
