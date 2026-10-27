import * as THREE from 'three';
import { Scenario, COLORS, makeBoxMesh } from './Scenario.js';
import { labelSprite } from './sorting.js';

const PALLET = { x: 0.8, z: 1.2, h: 0.144 };
const BOX = new THREE.Vector3(0.38, 0.25, 0.28);
const SKUS = ['SKU-1001', 'SKU-1002', 'SKU-1003', 'SKU-1004'];
const TOOL_LENGTH = 0.3;

/**
 * Despaletizado con el IRB 660: un palé europeo con dos capas de cajas de 6 a 28 kg. El robot
 * las toma con una ventosa de vacío y las reparte en cuatro palés de destino por color o SKU.
 */
export class PalletScenario extends Scenario {
  id = 'pallet';
  title = 'Despaletizado y clasificación por color o SKU';
  clearance = 0.25;
  safeHeight = 1.25;
  speed = 1.2;

  build() {
    this.lab.table.group.visible = false;
    this.physics.addStaticBox(new THREE.Vector3(0, -0.05, 0), new THREE.Vector3(20, 0.05, 20), { friction: 0.8 });
    this.buildVacuumTool();

    this.source = this.buildPallet(new THREE.Vector3(2.0, 0, 0), 'Palé de entrada');
    const dests = [
      ['A', 'rojo', SKUS[0], 0, 2.0],
      ['B', 'azul', SKUS[1], 0, -2.0],
      ['C', 'verde', SKUS[2], -1.0, 1.75],
      ['D', 'amarillo', SKUS[3], -1.0, -1.75],
    ];
    for (const [id, color, sku, x, z] of dests) {
      const p = this.buildPallet(new THREE.Vector3(x, 0, z), `${id} · ${color} · ${sku}`, COLORS[color]);
      const dest = {
        id,
        label: `Palé ${id}`,
        color,
        sku,
        count: 0,
        nextSlot: () => {
          const n = dest.count;
          const layer = Math.floor(n / 8);
          const k = n % 8;
          const pos = new THREE.Vector3(x + ((k % 2) - 0.5) * 0.39, PALLET.h + layer * BOX.y + 0.002, z + (Math.floor(k / 2) - 1.5) * 0.29);
          return { position: pos, yaw: 0 };
        },
      };
      this.destinations.push(dest);
      void p;
    }
    this.resetRules();
    this.nextId = 1;
    this.fillSourcePallet();
  }

  buildPallet(center, label, accent) {
    const wood = new THREE.MeshStandardMaterial({ color: 0xc8a06a, roughness: 0.85 });
    const g = new THREE.Group();
    g.position.copy(center);
    // Tablas superiores, tacos y tablas inferiores de un palé EUR (800 × 1200 × 144 mm).
    for (let i = 0; i < 5; i++) {
      const plank = new THREE.Mesh(new THREE.BoxGeometry(i % 2 ? 0.1 : 0.145, 0.022, PALLET.z), wood);
      plank.position.set(-PALLET.x / 2 + 0.072 + i * ((PALLET.x - 0.145) / 4), PALLET.h - 0.011, 0);
      g.add(plank);
    }
    for (const sx of [-1, 0, 1]) {
      for (const sz of [-1, 0, 1]) {
        const block = new THREE.Mesh(new THREE.BoxGeometry(0.145, 0.078, sx ? 0.1 : 0.145), wood);
        block.position.set(sx * (PALLET.x / 2 - 0.072), 0.022 + 0.039, sz * (PALLET.z / 2 - 0.06));
        g.add(block);
      }
      const runner = new THREE.Mesh(new THREE.BoxGeometry(0.145, 0.022, PALLET.z), wood);
      runner.position.set(sx * (PALLET.x / 2 - 0.072), 0.011, 0);
      g.add(runner);
    }
    if (accent) {
      const tag = new THREE.Mesh(new THREE.BoxGeometry(PALLET.x + 0.02, 0.012, 0.04), new THREE.MeshStandardMaterial({ color: accent }));
      tag.position.set(0, 0.006, PALLET.z / 2 + 0.04);
      g.add(tag);
    }
    g.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    g.add(labelSprite(label, new THREE.Vector3(0, PALLET.h + 1.0, 0), 0.9));
    this.group.add(g);
    this.physics.addStaticBox(center.clone().setY(PALLET.h / 2), new THREE.Vector3(PALLET.x / 2, PALLET.h / 2, PALLET.z / 2), { friction: 0.8 });
    return g;
  }

  fillSourcePallet() {
    const colors = Object.keys(COLORS);
    for (let layer = 0; layer < 2; layer++) {
      for (let k = 0; k < 8; k++) {
        const color = colors[Math.floor(Math.random() * colors.length)];
        const sku = SKUS[Math.floor(Math.random() * SKUS.length)];
        const mesh = makeBoxMesh(BOX, COLORS[color], sku);
        mesh.position.set(2.0 + ((k % 2) - 0.5) * 0.39, PALLET.h + layer * BOX.y + BOX.y / 2 + 0.001, (Math.floor(k / 2) - 1.5) * 0.29);
        this.lab.scene.add(mesh);
        const mass = 6 + Math.random() * 22;
        this.physics.addItem(mesh, BOX.clone().multiplyScalar(0.5), mass, {
          friction: 0.7,
          data: { id: `caja-${this.nextId++}`, color, sku },
        });
      }
    }
  }

  /** Ventosa de vacío con bastidor de aluminio y 6 copas, colgada de la brida. */
  buildVacuumTool() {
    const flange = this.robot.flange;
    const at = this.robot.kin.tcpFlange.clone();
    const tool = new THREE.Group();
    tool.position.copy(at);
    const alu = new THREE.MeshStandardMaterial({ color: 0xb9bec4, metalness: 0.85, roughness: 0.3 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1f1f1f, roughness: 0.7 });
    const adapter = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.08, 32), alu);
    adapter.position.y = -0.04;
    tool.add(adapter);
    const mast = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.14, 0.08), alu);
    mast.position.y = -0.15;
    tool.add(mast);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.03, 0.24), alu);
    frame.position.y = -0.235;
    tool.add(frame);
    const red = new THREE.Mesh(new THREE.BoxGeometry(0.345, 0.008, 0.02), new THREE.MeshStandardMaterial({ color: 0xff000f }));
    red.position.set(0, -0.218, 0.11);
    tool.add(red);
    for (const x of [-0.12, 0, 0.12]) {
      for (const z of [-0.08, 0.08]) {
        const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.022, 0.05, 20), dark);
        cup.position.set(x, -0.275, z);
        tool.add(cup);
      }
    }
    tool.traverse((o) => o.isMesh && (o.castShadow = true));
    flange.add(tool);
    this.tool = tool;
    this.robot.kin.setToolLength(TOOL_LENGTH);
  }

  /** La caja más alta del palé de entrada. */
  async nextItem() {
    let best = null;
    for (const item of this.physics.items) {
      if (item.held || item.done) continue;
      const p = item.mesh.position;
      if (Math.abs(p.x - 2.0) > PALLET.x / 2 || Math.abs(p.z) > PALLET.z / 2) continue;
      if (!best || p.y > best.mesh.position.y + 0.01 || (Math.abs(p.y - best.mesh.position.y) < 0.01 && p.z > best.mesh.position.z)) best = item;
    }
    if (!best) {
      this.emit('done');
      this.stop();
    }
    return best;
  }

  async pickPlace(item, dest) {
    const r = await super.pickPlace(item, dest);
    if (r.ok) item.done = true;
    return r;
  }

  async skipItem(item) {
    item.done = true;
  }

  graspDepth() {
    return 0;
  }

  async openTool() {
    await new Promise((r) => setTimeout(r, 250));
  }

  async closeTool() {
    // Tiempo de formación de vacío.
    await new Promise((r) => setTimeout(r, 300));
  }

  /** Repone el palé de entrada. */
  refill() {
    for (const item of [...this.physics.items]) this.physics.removeItem(item);
    for (const d of this.destinations) d.count = 0;
    this.fillSourcePallet();
    this.emit('rules');
  }

  dispose() {
    this.tool?.removeFromParent();
    this.robot.kin.setToolLength(0);
    this.lab.table.group.visible = true;
    super.dispose();
  }
}
