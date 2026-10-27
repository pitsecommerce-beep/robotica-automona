import * as THREE from 'three';
import { Scenario, COLORS, makeBoxMesh } from './Scenario.js';

const BELT = { x: 0.36, width: 0.11, top: 0.07, from: 0.45, to: -0.45, speed: 0.1, spawn: 0.4 };
const BIN = { size: 0.13, wall: 0.006, height: 0.05 };

/**
 * Clasificación en línea con el YuMi: una cinta trae paquetes de colores, una fotocélula la
 * detiene en la zona de recogida y el robot deja cada paquete en su cajón según las reglas.
 */
export class SortingScenario extends Scenario {
  id = 'sorting';
  title = 'Clasificación de paquetes por color en línea';
  clearance = 0.06;
  safeHeight = 0.15;
  speed = 0.35;

  build() {
    const { physics } = this;
    this.lab.table.group.visible = true;
    // Mesa (tablero) como colisionador.
    const t = this.lab.table;
    physics.addStaticBox(new THREE.Vector3(0, t.height - 0.0125, 0), new THREE.Vector3(t.size.x / 2, 0.0125, t.size.z / 2));
    physics.addStaticBox(new THREE.Vector3(0, -0.05, 0), new THREE.Vector3(10, 0.05, 10)); // suelo

    this.buildConveyor();
    const bins = [
      ['A', 'rojo', 0.14, 0.27],
      ['B', 'azul', 0.14, -0.27],
      ['C', 'verde', -0.04, 0.33],
      ['D', 'amarillo', -0.04, -0.33],
    ];
    for (const [id, color, x, z] of bins) this.destinations.push(this.buildBin(id, color, x, z));
    this.resetRules();
    this.spawnTimer = 0;
    this.nextId = 1;
    this.beltRunning = true;
    physics.beforeStep.add((this._belt = (dt) => this.driveBelt(dt)));
    for (let i = 0; i < 2; i++) this.spawn(BELT.spawn - i * 0.16);
  }

  buildConveyor() {
    const len = BELT.from - BELT.to;
    const zc = (BELT.from + BELT.to) / 2;
    const frameMat = new THREE.MeshStandardMaterial({ color: 0xb9bec4, metalness: 0.8, roughness: 0.35 });
    const beltTex = beltTexture();
    beltTex.repeat.set(1, len / 0.05);
    this.beltTex = beltTex;
    const belt = new THREE.Mesh(
      new THREE.BoxGeometry(BELT.width, 0.01, len),
      new THREE.MeshStandardMaterial({ map: beltTex, roughness: 0.85 }),
    );
    belt.position.copy(this.toWorld(BELT.x, BELT.top - 0.005, zc));
    belt.receiveShadow = true;
    this.group.add(belt);
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.03, len), frameMat);
      rail.position.copy(this.toWorld(BELT.x + s * (BELT.width / 2 + 0.006), BELT.top + 0.005, zc));
      rail.castShadow = true;
      this.group.add(rail);
      this.physics.addStaticBox(rail.position, new THREE.Vector3(0.006, 0.015, len / 2));
    }
    const body = new THREE.Mesh(new THREE.BoxGeometry(BELT.width + 0.024, BELT.top - 0.01, len), frameMat);
    body.position.copy(this.toWorld(BELT.x, (BELT.top - 0.01) / 2, zc));
    body.castShadow = true;
    this.group.add(body);
    this.physics.addStaticBox(this.toWorld(BELT.x, BELT.top - 0.005, zc), new THREE.Vector3(BELT.width / 2, 0.005, len / 2), { friction: 0.9 });

    // Fotocélula con su haz en la zona de recogida.
    const sensorMat = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.4 });
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.06, 0.012), sensorMat);
      post.position.copy(this.toWorld(BELT.x + s * (BELT.width / 2 + 0.02), BELT.top + 0.03, 0));
      this.group.add(post);
    }
    this.beam = new THREE.Mesh(
      new THREE.BoxGeometry(BELT.width + 0.04, 0.002, 0.002),
      new THREE.MeshBasicMaterial({ color: 0xff000f, transparent: true, opacity: 0.6 }),
    );
    this.beam.position.copy(this.toWorld(BELT.x, BELT.top + 0.02, 0));
    this.group.add(this.beam);
  }

  buildBin(id, color, x, z) {
    const mat = new THREE.MeshStandardMaterial({ color: COLORS[color], roughness: 0.5 });
    const inner = new THREE.MeshStandardMaterial({ color: 0x3a3d41, roughness: 0.8 });
    const g = new THREE.Group();
    g.position.copy(this.toWorld(x, 0, z));
    const s = BIN.size;
    const floor = new THREE.Mesh(new THREE.BoxGeometry(s, 0.004, s), inner);
    floor.position.y = 0.002;
    g.add(floor);
    const walls = [
      [s, BIN.wall, 0, s / 2],
      [s, BIN.wall, 0, -s / 2],
      [BIN.wall, s, s / 2, 0],
      [BIN.wall, s, -s / 2, 0],
    ];
    for (const [w, d, ox, oz] of walls) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, BIN.height, d), mat);
      wall.position.set(ox, BIN.height / 2, oz);
      wall.castShadow = true;
      g.add(wall);
      this.physics.addStaticBox(g.position.clone().add(wall.position), new THREE.Vector3(w / 2, BIN.height / 2, d / 2));
    }
    g.add(labelSprite(`${id} · ${color}`, new THREE.Vector3(0, BIN.height + 0.03, 0)));
    this.group.add(g);
    const dest = {
      id,
      label: `Cajón ${id}`,
      color,
      count: 0,
      center: new THREE.Vector3(x, 0, z),
      nextSlot: (item) => {
        // Rejilla 3×3 por capa dentro del cajón.
        const n = dest.count;
        const layer = Math.floor(n / 9);
        const k = n % 9;
        const step = (s - 0.02) / 3;
        const pos = new THREE.Vector3(x + ((k % 3) - 1) * step, 0.004 + layer * 2 * item.half.y, z + (Math.floor(k / 3) - 1) * step);
        return { position: pos, yaw: 0 };
      },
    };
    return dest;
  }

  spawn(z = BELT.spawn) {
    const colors = Object.keys(COLORS);
    const color = colors[Math.floor(Math.random() * colors.length)];
    const edge = 0.03 + Math.random() * 0.01;
    const heavy = Math.random() < 0.08;
    // Paquetes de 30-40 mm; densidad de cartón con contenido (≈ 2-6 g/cm³ ⇒ 60-350 g). Alguno pesado.
    const mass = heavy ? 0.6 + Math.random() * 0.3 : 0.06 + Math.random() * 0.29;
    const size = new THREE.Vector3(edge, edge, edge);
    const sku = `P-${100 + Math.floor(Math.random() * 4)}`;
    const mesh = makeBoxMesh(size, COLORS[color], null);
    mesh.position.copy(this.toWorld(BELT.x + (Math.random() - 0.5) * 0.02, BELT.top + edge / 2 + 0.002, z));
    mesh.rotation.y = (Math.random() - 0.5) * 0.5;
    this.lab.scene.add(mesh);
    const item = this.physics.addItem(mesh, size.clone().multiplyScalar(0.5), mass, {
      data: { id: `paquete-${this.nextId++}`, color, sku, heavy },
    });
    this.emit('spawn', { item });
    return item;
  }

  /** La cinta arrastra los paquetes que están sobre ella y se para con la fotocélula. */
  driveBelt() {
    let blocked = false;
    for (const item of this.physics.items) {
      if (item.held || item.skipped) continue;
      const p = this.toRobot(item.body.translation());
      if (Math.abs(p.x - BELT.x) < BELT.width / 2 + 0.01 && p.z < 0.012 && p.z > -0.03 && p.y < BELT.top + 0.05) blocked = true;
    }
    this.beltRunning = !blocked && this.running;
    const v = this.beltRunning ? BELT.speed : 0;
    for (const item of this.physics.items) {
      if (item.held) continue;
      const t = item.body.translation();
      const p = this.toRobot(t);
      const onBelt = Math.abs(p.x - BELT.x) < BELT.width / 2 && p.z < BELT.from + 0.02 && p.z > BELT.to && p.y - item.half.y < BELT.top + 0.006;
      if (!onBelt) continue;
      const lv = item.body.linvel();
      item.body.setLinvel({ x: lv.x * 0.8, y: lv.y, z: -v }, true);
    }
  }

  async nextItem() {
    for (const item of this.physics.items) {
      if (item.held || item.skipped) continue;
      const p = this.toRobot(item.mesh.position);
      const v = item.body.linvel();
      if (Math.abs(p.z) < 0.03 && Math.abs(p.x - BELT.x) < BELT.width && Math.hypot(v.x, v.y, v.z) < 0.01) return item;
    }
    return null;
  }

  async skipItem(item) {
    // Se deja pasar: la cinta lo lleva al final de línea (rechazo).
    item.skipped = true;
    this.robot.goHome();
  }

  graspDepth(item) {
    return Math.min(0.013, item.half.y);
  }

  async openTool() {
    await this.robot.gripTo(1);
  }

  async closeTool(item) {
    const stroke = this.robot.gripper.stroke;
    await this.robot.gripTo(Math.max(0, (item.half.x - 0.001) / stroke));
  }

  update(dt) {
    if (this.beltRunning) this.beltTex.offset.y += (BELT.speed * dt) / 0.05;
    this.beam.material.opacity = this.beltRunning ? 0.6 : 1;
    if (this.running) {
      this.spawnTimer += dt;
      const onBelt = [...this.physics.items].filter((i) => !i.held && this.toRobot(i.mesh.position).z > 0.25).length;
      if (this.spawnTimer > 3.5 && onBelt === 0) {
        this.spawnTimer = 0;
        this.spawn();
      }
    }
    // Paquetes que caen al final de línea o fuera de la mesa.
    for (const item of [...this.physics.items]) {
      if (item.mesh.position.y < this.lab.table.height - 0.2) {
        this.stats.rejected += item.skipped ? 1 : 0;
        this.physics.removeItem(item);
      }
    }
  }

  dispose() {
    this.physics.beforeStep.delete(this._belt);
    super.dispose();
  }
}

function beltTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#26292c';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#33373b';
  for (let y = 0; y < 64; y += 8) g.fillRect(0, y, 64, 3);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function labelSprite(text, position, scale = 0.12) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#ff000f';
  g.fillRect(0, 0, 8, 64);
  g.fillStyle = '#1f1f1f';
  g.font = '600 30px Inter, sans-serif';
  g.textBaseline = 'middle';
  g.fillText(text, 22, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true }));
  sprite.scale.set(scale, scale / 4, 1);
  sprite.position.copy(position);
  return sprite;
}
