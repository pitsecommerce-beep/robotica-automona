import * as THREE from 'three';
import { createLab } from './scene/lab.js';
import { Robot } from './robot/Robot.js';
import { toolDown } from './robot/Kinematics.js';
import { createPendant } from './ui/pendant.js';

const ROBOTS = [{ id: 'irb14050', name: 'ABB YuMi IRB 14050' }];
const READY = 'Listo · Motores ON';
const CAMERA_HOME = { position: [0.95, 1.3, 1.05], target: [0.05, 1.03, 0] };

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
let workspace = null;

async function loadRobot(id) {
  document.getElementById('loading').classList.remove('hidden');
  setStatus('Cargando robot…', 'busy');
  if (robot) lab.scene.remove(robot.root);
  if (workspace) lab.scene.remove(workspace);
  robot = await Robot.load(id);
  // Montado sobre la mesa, mirando hacia el lado largo.
  robot.root.position.set(-0.25, lab.table.height, 0);
  lab.scene.add(robot.root);
  workspace = buildWorkspaceRing(robot);
  lab.scene.add(workspace);
  axesHelpers = buildAxisHelpers(robot);
  axesHelpers.forEach((h) => (h.visible = document.getElementById('toggle-axes').classList.contains('on')));
  const pendant = createPendant(robot, {
    // text null = terminado bien; isError marca el fallo.
    onStatus: (text, isError) => setStatus(text ?? READY, isError ? 'error' : text ? 'busy' : 'ready'),
  });
  renderCard(robot);
  await robot.goHome();
  pendant.fillFromTcp();
  document.getElementById('loading').classList.add('hidden');
  setStatus(READY);
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

/** Círculo del alcance nominal sobre la mesa, centrado en el eje 1. */
function buildWorkspaceRing(r) {
  const R = r.spec.specs.reach_m;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(R - 0.003, R, 128),
    new THREE.MeshBasicMaterial({ color: 0xff000f, transparent: true, opacity: 0.35 }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(r.root.position).add(new THREE.Vector3(0, 0.001, 0));
  return ring;
}

// Marcador del objetivo cartesiano.
const marker = new THREE.Group();
{
  const mat = new THREE.MeshBasicMaterial({ color: 0xff000f });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.012, 0.016, 32), mat);
  ring.rotation.x = -Math.PI / 2;
  marker.add(ring);
  for (const rot of [0, Math.PI / 2]) {
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 0.002), mat);
    bar.rotation.set(-Math.PI / 2, 0, rot);
    marker.add(bar);
  }
  marker.visible = false;
  lab.scene.add(marker);
}

// "Ir a clic": aproximación por encima del punto (MoveJ) y bajada en línea recta (MoveL).
const clickBtn = document.getElementById('click-mode');
clickBtn.onclick = () => clickBtn.classList.toggle('on');
const raycaster = new THREE.Raycaster();
let downAt = null;
viewport.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]));
viewport.addEventListener('pointerup', async (e) => {
  if (!clickBtn.classList.contains('on') || !robot || !downAt) return;
  if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return; // fue un arrastre de cámara
  const rect = lab.renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, lab.camera);
  const hit = raycaster.intersectObject(lab.table.top)[0];
  if (!hit) return;
  marker.position.copy(hit.point).add(new THREE.Vector3(0, 0.001, 0));
  marker.visible = true;
  const local = robot.root.worldToLocal(hit.point.clone());
  const yaw = 0;
  const above = { position: local.clone().add(new THREE.Vector3(0, 0.12, 0)), quaternion: toolDown(yaw) };
  const touch = { position: local.clone().add(new THREE.Vector3(0, 0.02, 0)), quaternion: toolDown(yaw) };
  await run('Aproximando…', async () => {
    let r = await robot.moveJTo(above);
    if (r.ok) {
      robot.setGripper(1);
      r = await robot.moveL(touch, 0.15);
    }
    if (r.ok) {
      robot.setGripper(0);
      await wait(1100);
      r = await robot.moveL(above, 0.25);
    }
    return r;
  });
});

document.getElementById('toggle-axes').onclick = (e) => {
  const on = e.currentTarget.classList.toggle('on');
  axesHelpers?.forEach((h) => (h.visible = on));
};
document.getElementById('reset-view').onclick = () => {
  lab.camera.position.set(...CAMERA_HOME.position);
  lab.controls.target.set(...CAMERA_HOME.target);
};
document.getElementById('btn-stop').onclick = () => {
  robot?.stop();
  setStatus('Parado por el operador', 'error');
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(label, fn) {
  setStatus(label, 'busy');
  const r = await fn();
  if (r && r.ok === false) setStatus(r.reason, 'error');
  else setStatus(READY);
}
document.getElementById('btn-home').onclick = () => run('Moviendo a Home…', () => robot.goHome());
document.getElementById('btn-zero').onclick = () => run('Moviendo a cero…', () => robot.moveJ(robot.joints.map(() => 0)));
document.getElementById('btn-demo').onclick = () =>
  run('Demo en curso…', async () => {
    // Cuadrado sobre la mesa con la pinza hacia abajo: MoveJ al primer vértice y MoveL entre los demás.
    const corners = [
      [0.3, 0.06, -0.12],
      [0.42, 0.06, -0.12],
      [0.42, 0.06, 0.12],
      [0.3, 0.06, 0.12],
      [0.3, 0.06, -0.12],
    ].map(([x, y, z], i) => ({ position: new THREE.Vector3(x, y, z), quaternion: toolDown(i * 30) }));
    let r = await robot.moveJTo(corners[0]);
    for (const c of corners.slice(1)) {
      if (!r.ok) break;
      robot.setGripper(robot.gripper.target ? 0 : 1);
      r = await robot.moveL(c, 0.3);
    }
    if (!r.ok) return r;
    await robot.goHome();
  });
select.onchange = () => loadRobot(select.value);

// Acceso desde la consola del navegador para depurar.
window.sim = { lab, get robot() { return robot; } };

const clock = new THREE.Clock();
lab.renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  robot?.update(dt);
  lab.controls.update();
  lab.renderer.render(lab.scene, lab.camera);
});

loadRobot(ROBOTS[0].id).catch((err) => {
  console.error(err);
  setStatus('Error al cargar el robot', 'error');
  document.getElementById('loading').textContent = `Error: ${err.message}`;
});
