import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { Kinematics, toolDown } from '../src/robot/Kinematics.js';

const dir = new URL('../public/robots/irb14050/', import.meta.url);
const spec = JSON.parse(readFileSync(new URL('robot.json', dir)));
const kinJson = JSON.parse(readFileSync(new URL('kinematics.json', dir)));
const kin = new Kinematics(kinJson, spec);
const DEG = Math.PI / 180;

test('FK en cero coincide con el TCP del CAD', () => {
  const { position } = kin.forward(new Array(7).fill(0));
  assert.ok(position.distanceTo(new THREE.Vector3(...kinJson.tool.tcp)) < 1e-9);
});

test('IK recupera poses alcanzables generadas por FK', () => {
  let state = 7;
  const rnd = () => ((state = (state * 16807) % 2147483647) / 2147483647);
  let ok = 0;
  const N = 200;
  for (let k = 0; k < N; k++) {
    const q = kin.joints.map((j) => j.min + 0.1 * (j.max - j.min) + rnd() * 0.8 * (j.max - j.min));
    const target = kin.forward(q);
    const r = kin.inverse(target, kin.rest);
    if (r.ok) {
      const fk = kin.forward(r.q);
      assert.ok(fk.position.distanceTo(target.position) < 1e-3);
      r.q.forEach((v, i) => assert.ok(v >= kin.joints[i].min - 1e-9 && v <= kin.joints[i].max + 1e-9));
      ok++;
    }
  }
  assert.ok(ok / N > 0.95, `tasa de éxito ${ok}/${N}`);
});

test('alcanza la mesa con la herramienta hacia abajo', () => {
  const fails = [];
  for (const [x, z] of [[0.3, 0], [0.35, 0.15], [0.3, -0.2], [0.2, 0.25], [0.4, 0]]) {
    for (const h of [0.03, 0.15]) {
      const r = kin.inverse({ position: new THREE.Vector3(x, h, z), quaternion: toolDown(0) }, kin.rest);
      if (!r.ok) fails.push([x, h, z, r.posErr.toFixed(4), (r.rotErr / DEG).toFixed(2)]);
    }
  }
  assert.deepEqual(fails, []);
});

test('rechaza objetivos fuera de alcance', () => {
  const r = kin.inverse({ position: new THREE.Vector3(0.9, 0.3, 0), quaternion: toolDown(0) }, kin.rest);
  assert.equal(r.ok, false);
});
