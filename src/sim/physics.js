import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

const FIXED_DT = 1 / 120;

/**
 * Mundo físico (Rapier) sincronizado con Three.js. Paso fijo de 1/120 s, gravedad real.
 * Los objetos manipulables son cuerpos dinámicos con su masa real; mientras el robot los
 * sujeta pasan a ser cinemáticos y siguen al TCP.
 */
export class Physics {
  static async create() {
    await RAPIER.init();
    return new Physics();
  }

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.items = new Set();
    this.statics = [];
    this.acc = 0;
    this.time = 0;
    this.beforeStep = new Set();
  }

  /** Caja estática (suelo, mesa, paredes de cajones…), en coordenadas de mundo. */
  addStaticBox(center, half, { rotationY = 0, friction = 0.7 } = {}) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotationY);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(center.x, center.y, center.z).setRotation(q),
    );
    const collider = this.world.createCollider(RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setFriction(friction), body);
    this.statics.push(body);
    return { body, collider };
  }

  /** Objeto dinámico con masa real; mesh se actualiza con la simulación. */
  addItem(mesh, half, massKg, { friction = 0.6, restitution = 0.05, data = {} } = {}) {
    const p = mesh.position;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y, p.z)
        .setRotation(mesh.quaternion)
        .setLinearDamping(0.05)
        .setAngularDamping(0.2)
        .setCcdEnabled(true),
    );
    const volume = 8 * half.x * half.y * half.z;
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
        .setDensity(massKg / volume)
        .setFriction(friction)
        .setRestitution(restitution),
      body,
    );
    const item = { mesh, body, collider, half: half.clone(), mass: massKg, held: false, ...data };
    this.items.add(item);
    return item;
  }

  removeItem(item) {
    this.world.removeRigidBody(item.body);
    item.mesh.removeFromParent();
    this.items.delete(item);
  }

  /** El robot agarra el objeto: deja de responder a la gravedad y sigue a la herramienta. */
  grab(item) {
    item.held = true;
    item.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
  }

  /** Suelta el objeto con la velocidad que lleve la herramienta. */
  release(item, velocity = new THREE.Vector3()) {
    item.held = false;
    item.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    item.body.setLinvel(velocity, true);
    item.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /** Mueve un objeto sujeto (cinemático) a una pose de mundo. */
  moveHeld(item, position, quaternion) {
    item.body.setNextKinematicTranslation(position);
    item.body.setNextKinematicRotation(quaternion);
  }

  /** Recoloca un objeto al instante (al generar o reiniciar). */
  teleport(item, position, quaternion = new THREE.Quaternion()) {
    item.body.setTranslation(position, true);
    item.body.setRotation(quaternion, true);
    item.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    item.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  step(dt) {
    this.acc += Math.min(dt, 0.1);
    while (this.acc >= FIXED_DT) {
      this.beforeStep.forEach((fn) => fn(FIXED_DT));
      this.world.step();
      this.acc -= FIXED_DT;
      this.time += FIXED_DT;
    }
    for (const item of this.items) {
      const t = item.body.translation();
      const r = item.body.rotation();
      item.mesh.position.set(t.x, t.y, t.z);
      item.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  dispose() {
    this.world.free();
    this.items.clear();
  }
}
