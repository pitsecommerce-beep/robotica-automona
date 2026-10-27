import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { Kinematics, toolDown, sceneFromAbb, abbFromScene } from '../src/robot/Kinematics.js';
import { Robot } from '../src/robot/Robot.js';

const dir = new URL('../public/robots/irb660/', import.meta.url);
const spec = JSON.parse(readFileSync(new URL('robot.json', dir)));
const kinJson = JSON.parse(readFileSync(new URL('kinematics.json', dir)));
const kin = new Kinematics(kinJson, spec);
const DEG = Math.PI / 180;

// Tabla "Positions at wrist center" de la especificación (X, Z en mm; ejes 2 y 3 en grados).
const TABLE = [
  [1910, 1833, 0, 0],
  [972, 1966, -42, -20],
  [895, 870, -42, 28],
  [866, 207, 50, 120],
  [1160, -505, 85, 120],
  [3139, 315, 85, 15],
  [2809, 1837, 50, -20],
];

test('FK reproduce la tabla de posiciones de la especificación', () => {
  for (const [x, z, a2, a3] of TABLE) {
    const p = abbFromScene(kin.forward([0, a2 * DEG, a3 * DEG, 0]).position);
    assert.ok(Math.abs(p.x * 1000 - x) < 2 && Math.abs(p.z * 1000 - z) < 2, `(${a2}, ${a3}) → ${p.x * 1000}, ${p.z * 1000}`);
  }
});

test('la brida queda horizontal en toda la zona de trabajo', () => {
  const down = new THREE.Vector3(0, -1, 0);
  for (const [, , a2, a3] of TABLE) {
    const { quaternion } = kin.forward([0.5, a2 * DEG, a3 * DEG, 1]);
    assert.ok(new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).angleTo(down) < 1e-6);
  }
});

test('los límites combinados de los ejes 2 y 3 se respetan', () => {
  assert.equal(kin.withinLimits([0, -42 * DEG, 100 * DEG, 0]), false);
  assert.equal(kin.withinLimits([0, 0, 10 * DEG, 0]), true);
});

test('IK alcanza posiciones de paletizado con la brida hacia abajo', () => {
  for (const [x, y, z] of [[2.2, 0, 0.6], [1.5, -1.2, 1.4], [2.6, 0.8, 0.3], [1.2, 1.2, 2.0]]) {
    const target = { position: sceneFromAbb({ x, y, z }), quaternion: toolDown(30) };
    const r = kin.inverse(target, kin.rest);
    assert.ok(r.ok, `(${x}, ${y}, ${z}) err ${r.posErr}`);
    assert.ok(kin.withinLimits(r.q));
  }
});

test('el cilindro compensador sigue al brazo inferior', () => {
  const r = new Robot(spec, kinJson, new THREE.Group());
  const rod = r.links.find((l) => l.name === 'bal_rod');
  r.setJointsDeg([0, 60, 60, 0]);
  const extended = rod.value;
  r.setJointsDeg([0, -30, 0, 0]);
  assert.ok(Math.abs(extended - rod.value) > 0.05);
});
