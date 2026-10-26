import * as THREE from 'three';
import { createLab } from './scene/lab.js';
import { Robot } from './robot/Robot.js';
import { createPendant } from './ui/pendant.js';

const ROBOTS = [{ id: 'irb14050', name: 'ABB YuMi IRB 14050' }];

const viewport = document.getElementById('viewport');
const lab = createLab(viewport);
const statusEl = document.getElementById('status');
const statusText = document.getElementById('status-text');

function setStatus(text, state = 'ready') {
  statusText.textContent = text;
  statusEl.className = `status ${state}`;
}

const select = document.getElementById('robot-select');
select.innerHTML = ROBOTS.map((r) => `<option value="${r.id}">${r.name}</option>`).join('');

let robot = null;
let axesHelpers = null;

async function loadRobot(id) {
  document.getElementById('loading').classList.remove('hidden');
  setStatus('Cargando robot…', 'busy');
  if (robot) lab.scene.remove(robot.root);
  robot = await Robot.load(id);
  // Montado sobre la mesa, mirando hacia el lado largo.
  robot.root.position.set(-0.25, lab.table.height, 0);
  lab.scene.add(robot.root);
  axesHelpers = buildAxisHelpers(robot);
  axesHelpers.forEach((h) => (h.visible = document.getElementById('toggle-axes').classList.contains('on')));
  createPendant(robot);
  renderCard(robot);
  await robot.goHome();
  document.getElementById('loading').classList.add('hidden');
  setStatus('Listo · Motores ON');
}

function renderCard(r) {
  const s = r.spec.specs;
  document.getElementById('robot-card').innerHTML = `
    <b>${r.spec.name}</b>
    <div class="kv"><span>Ejes</span><span>${s.axes}</span></div>
    <div class="kv"><span>Alcance</span><span>${s.reach_m * 1000} mm</span></div>
    <div class="kv"><span>Carga útil</span><span>${s.payload_kg * 1000} g</span></div>
    <div class="kv"><span>Vel. TCP máx.</span><span>${s.max_tcp_velocity_mps} m/s</span></div>
    <div class="kv"><span>Repetibilidad</span><span>${s.pose_repeatability_mm} mm</span></div>`;
}

/** Línea roja sobre cada eje articular, útil para validar la cinemática. */
function buildAxisHelpers(r) {
  return r.joints.map((j) => {
    const geo = new THREE.BufferGeometry().setFromPoints([j.axis.clone().multiplyScalar(-0.09), j.axis.clone().multiplyScalar(0.09)]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xff000f, depthTest: false }));
    line.renderOrder = 10;
    j.pivot.add(line);
    return line;
  });
}

document.getElementById('toggle-axes').onclick = (e) => {
  const on = e.currentTarget.classList.toggle('on');
  axesHelpers?.forEach((h) => (h.visible = on));
};
document.getElementById('reset-view').onclick = () => {
  lab.camera.position.set(0.95, 1.3, 1.05);
  lab.controls.target.set(0.05, lab.table.height + 0.28, 0);
};

async function run(label, fn) {
  setStatus(label, 'busy');
  await fn();
  setStatus('Listo · Motores ON');
}
document.getElementById('btn-home').onclick = () => run('Moviendo a Home…', () => robot.goHome());
document.getElementById('btn-zero').onclick = () => run('Moviendo a cero…', () => robot.moveJ(robot.joints.map(() => 0)));
document.getElementById('btn-demo').onclick = () =>
  run('Demo en curso…', async () => {
    const poses = [
      [45, -40, 20, -30, 30, 80, 0],
      [45, -60, 20, -50, 30, 100, 90],
      [-45, -40, -20, -30, -30, 80, -90],
      [-45, -60, -20, -50, -30, 100, 0],
    ];
    for (const p of poses) {
      robot.setGripper(1);
      await robot.moveJ(p);
      robot.setGripper(0);
    }
    await robot.goHome();
  });
select.onchange = () => loadRobot(select.value);

const clock = new THREE.Clock();
lab.renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  robot?.update(dt);
  lab.controls.update();
  lab.renderer.render(lab.scene, lab.camera);
});

loadRobot(ROBOTS[0].id).catch((err) => {
  console.error(err);
  setStatus('Error al cargar el robot', 'busy');
  document.getElementById('loading').textContent = `Error: ${err.message}`;
});
