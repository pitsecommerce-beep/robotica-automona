import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { Robot } from '../src/robot/Robot.js';
import { toolDown } from '../src/robot/Kinematics.js';

const dir = new URL('../public/robots/irb14050/', import.meta.url);
const spec = JSON.parse(readFileSync(new URL('robot.json', dir)));
const kinJson = JSON.parse(readFileSync(new URL('kinematics.json', dir)));

function makeRobot() {
  const r = new Robot(spec, kinJson, new THREE.Group());
  r.setJointsDeg(r.joints.map((j) => spec.home_deg[j.name]));
  return r;
}

function runUntilIdle(r, dt = 1 / 60) {
  for (let t = 0; t < 30 && r.busy; t += dt) r.update(dt);
}

test('MoveL sigue una recta y respeta las velocidades articulares', async () => {
  const r = makeRobot();
  const a = { position: new THREE.Vector3(0.3, 0.1, -0.15), quaternion: toolDown(0) };
  const b = { position: new THREE.Vector3(0.38, 0.05, 0.15), quaternion: toolDown(45) };
  const pj = r.moveJTo(a);
  runUntilIdle(r);
  assert.equal((await pj).ok, true);
  assert.ok(r.getTcpPose().position.distanceTo(a.position) < 1e-3);

  const plan = r.planLinear(b, 0.5);
  assert.equal(plan.ok, true, plan.reason);
  const dt = 0.01;
  const line = b.position.clone().sub(a.position).normalize();
  for (let k = 1; k < plan.path.length; k++) {
    plan.path[k].forEach((q, i) => {
      assert.ok(Math.abs(q - plan.path[k - 1][i]) / dt <= r.joints[i].vmax * 1.01, `eje ${i} demasiado rápido`);
    });
    const p = r.kin.forward(plan.path[k]).position.sub(a.position);
    const off = p.clone().sub(line.clone().multiplyScalar(p.dot(line))).length();
    assert.ok(off < 1e-3, `desvío de la recta ${off}`);
  }
  const pl = r.moveL(b, 0.5);
  runUntilIdle(r);
  assert.equal((await pl).ok, true);
  assert.ok(r.getTcpPose().position.distanceTo(b.position) < 1e-3);
});

test('MoveL hacia fuera del alcance falla sin mover el robot', async () => {
  const r = makeRobot();
  const q0 = r.q;
  const res = await r.moveL({ position: new THREE.Vector3(0.8, 0.1, 0), quaternion: toolDown(0) });
  assert.equal(res.ok, false);
  assert.deepEqual(r.q, q0);
});

test('la velocidad del TCP no supera el máximo del datasheet', () => {
  const r = makeRobot();
  r.setJointsDeg(r.kin.inverse({ position: new THREE.Vector3(0.25, 0.1, -0.2), quaternion: toolDown(0) }, r.q).q.map((v) => v * 180 / Math.PI));
  const plan = r.planLinear({ position: new THREE.Vector3(0.25, 0.1, 0.2), quaternion: toolDown(0) }, 5);
  assert.equal(plan.ok, true, plan.reason);
  let vmax = 0;
  for (let k = 1; k < plan.path.length; k++) {
    vmax = Math.max(vmax, r.kin.forward(plan.path[k]).position.distanceTo(r.kin.forward(plan.path[k - 1]).position) / 0.01);
  }
  assert.ok(vmax <= spec.specs.max_tcp_velocity_mps * 1.02, `TCP a ${vmax.toFixed(2)} m/s`);
});
