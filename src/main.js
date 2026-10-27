import * as THREE from 'three';
import { createLab } from './scene/lab.js';
import { Robot } from './robot/Robot.js';
import { toolDown } from './robot/Kinematics.js';
import { playGesture, EMOTION_GESTURE } from './robot/gestures.js';
import { createPendant } from './ui/pendant.js';
import { Presentation } from './ui/presentation.js';
import { Physics } from './sim/physics.js';
import { SortingScenario } from './scenarios/sorting.js';
import { PalletScenario } from './scenarios/pallet.js';
import { COLORS } from './scenarios/Scenario.js';
import { Voice } from './voice/voice.js';
import { Brain } from './brain/Brain.js';

const ROBOTS = [
  { id: 'irb14050', name: 'ABB YuMi IRB 14050' },
  { id: 'irb660', name: 'ABB IRB 660 · paletizador' },
];
const SCENARIOS = {
  lab: { title: 'Celda vacía', robot: null },
  sorting: { title: 'Clasificación de paquetes por color en línea', robot: 'irb14050', Class: SortingScenario },
  pallet: { title: 'Despaletizado y clasificación por color o SKU', robot: 'irb660', Class: PalletScenario },
};
const READY = 'Listo · Motores ON';

const $ = (id) => document.getElementById(id);
const viewport = $('viewport');
const lab = createLab(viewport);

let robot = null;
let robotId = null;
let scenario = null;
let scenarioKey = 'lab';
let physics = null;
let axesHelpers = null;
let workspace = null;
let pendant = null;

function setStatus(text, state = 'ready') {
  $('status-text').textContent = text;
  $('status').className = `status ${state}`;
}

$('robot-select').innerHTML = ROBOTS.map((r) => `<option value="${r.id}">${r.name}</option>`).join('');

// ------------------------------------------------------------------ robot

async function loadRobot(id) {
  if (robotId === id && robot) return;
  $('loading').classList.remove('hidden');
  setStatus('Cargando robot…', 'busy');
  if (robot) lab.scene.remove(robot.root);
  if (workspace) lab.scene.remove(workspace);
  robot = await Robot.load(id);
  robotId = id;
  $('robot-select').value = id;
  const floor = robot.spec.mount === 'floor';
  robot.root.position.set(floor ? 0 : -0.25, floor ? 0 : lab.table.height, 0);
  lab.scene.add(robot.root);
  const reach = robot.spec.specs.reach_m;
  lab.setCell(floor ? reach * 2 + 1.6 : 2.6, floor ? reach * 2 + 1.6 : 2.2);
  lab.table.group.visible = !floor;
  workspace = buildWorkspaceRing(robot);
  lab.scene.add(workspace);
  axesHelpers = buildAxisHelpers(robot);
  axesHelpers.forEach((h) => (h.visible = $('toggle-axes').classList.contains('on')));
  pendant = createPendant(robot, {
    onStatus: (text, isError) => setStatus(text ?? READY, isError ? 'error' : text ? 'busy' : 'ready'),
  });
  renderCard(robot);
  resetView();
  robot.setJointsDeg(robot.joints.map((j) => robot.spec.home_deg?.[j.name] ?? 0));
  pendant.fillFromTcp();
  $('loading').classList.add('hidden');
  setStatus(READY);
}

function renderCard(r) {
  const s = r.spec.specs;
  const fmtLoad = s.payload_kg < 1 ? `${s.payload_kg * 1000} g` : `${s.payload_kg} kg`;
  $('robot-card').innerHTML = `
    <b>${r.spec.name}</b>
    <div class="kv"><span>Ejes</span><span>${s.axes}</span></div>
    <div class="kv"><span>Alcance</span><span>${s.reach_m * 1000} mm</span></div>
    <div class="kv"><span>Carga útil</span><span>${fmtLoad}</span></div>
    <div class="kv"><span>Peso</span><span>${s.robot_mass_kg} kg</span></div>
    <div class="kv"><span>Repetibilidad</span><span>${s.pose_repeatability_mm} mm</span></div>`;
}

/** Línea roja sobre cada articulación, útil para validar la cinemática. */
function buildAxisHelpers(r) {
  const size = r.spec.view?.axis_helper_m ?? 0.09;
  return r.links
    .filter((l) => l.type !== 'prism')
    .map((l) => {
      const geo = new THREE.BufferGeometry().setFromPoints([l.axis.clone().multiplyScalar(-size), l.axis.clone().multiplyScalar(size)]);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xff000f, depthTest: false }));
      line.renderOrder = 10;
      l.pivot.add(line);
      return line;
    });
}

/** Círculo del alcance nominal, centrado en el eje 1. */
function buildWorkspaceRing(r) {
  const R = r.spec.specs.reach_m;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(R - R * 0.006, R, 160),
    new THREE.MeshBasicMaterial({ color: 0xff000f, transparent: true, opacity: 0.35 }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(r.root.position).add(new THREE.Vector3(0, 0.003, 0));
  return ring;
}

function resetView() {
  const v = robot.spec.view;
  lab.camera.position.set(...v.camera);
  lab.controls.target.set(...v.target);
}

// ------------------------------------------------------------------ escenarios

async function loadScenario(key) {
  const def = SCENARIOS[key];
  scenario?.dispose();
  scenario = null;
  physics?.dispose();
  physics = await Physics.create();
  // El robot avanza con el mismo paso fijo que la física: lo que sujeta se mueve sin saltos.
  physics.beforeStep.add((h) => robot?.update(h));
  scenarioKey = key;
  $('scenario-select').value = key;
  if (def.robot) await loadRobot(def.robot);
  robot.stop();
  robot.setJointsDeg(robot.joints.map((j) => robot.spec.home_deg?.[j.name] ?? 0));
  if (def.Class) {
    scenario = new def.Class({ lab, robot, physics, onEvent: onScenarioEvent });
    scenario.build();
  } else {
    lab.table.group.visible = robot.spec.mount !== 'floor';
  }
  $('scenario-state').textContent = 'Parado';
  $('scenario-state').className = 'tag muted';
  renderScenarioPanel();
  setStatus(READY);
}

function onScenarioEvent(e) {
  switch (e.type) {
    case 'status':
      $('scenario-state').textContent = e.running ? 'En marcha' : 'Parado';
      $('scenario-state').className = `tag ${e.running ? '' : 'muted'}`;
      setStatus(e.running ? `${scenario.title}…` : READY, e.running ? 'busy' : 'ready');
      renderScenarioPanel();
      break;
    case 'rules':
    case 'placed':
      renderScenarioPanel();
      break;
    case 'overload':
      robotSays(`Este paquete pesa ${e.item.mass.toFixed(2)} kg y mi carga máxima es de ${robot.spec.specs.payload_kg} kg. Lo dejo pasar.`, 'confused');
      break;
    case 'skip':
      addChat('robot', e.reason, 'aviso');
      break;
    case 'done':
      robotSays('¡Palé terminado! Todo clasificado.', 'excited').then(() => playGesture(robot, 'celebrate'));
      break;
    case 'error':
      setStatus(e.message, 'error');
      robotSays(`Tengo un problema: ${e.message}`, 'sad');
      break;
  }
}

function renderScenarioPanel() {
  const el = $('scenario-panel');
  if (!scenario) {
    el.innerHTML = `<p class="hint">Celda vacía: usa el movimiento manual, la demo o habla con el robot. Elige un escenario arriba para trabajar con objetos.</p>`;
    return;
  }
  const keys = scenario.sortBy === 'sku' ? scenario.destinations.map((d) => d.sku).filter(Boolean) : Object.keys(COLORS);
  const opts = (sel) => scenario.destinations.map((d) => `<option value="${d.id}" ${d.id === sel ? 'selected' : ''}>${d.id}</option>`).join('');
  el.innerHTML = `
    <div class="btn-row">
      <button class="btn primary" data-act="${scenario.running ? 'stop' : 'start'}">${scenario.running ? '■ Parar' : '▶ Iniciar'}</button>
      ${scenario.id === 'pallet' ? '<button class="btn" data-act="refill">Reponer palé</button>' : '<button class="btn" data-act="add">+3 paquetes</button>'}
    </div>
    <div class="panel-head" style="margin:10px 0 0"><span class="hint" style="margin:0">Clasificar por</span>
      <span class="seg"><button data-sort="color" class="${scenario.sortBy === 'color' ? 'on' : ''}">Color</button><button data-sort="sku" class="${scenario.sortBy === 'sku' ? 'on' : ''}">SKU</button></span>
    </div>
    <div class="rules">${keys
      .map((k) => {
        const sw = COLORS[k] !== undefined ? `#${new THREE.Color(COLORS[k]).getHexString()}` : '#8a8f95';
        return `<div class="rule"><span class="sw" style="background:${sw}"></span>${k}<select data-rule="${k}">${opts(scenario.rules.get(k))}</select></div>`;
      })
      .join('')}</div>
    <div class="counters">${scenario.destinations.map((d) => `<span>${d.label}: ${d.count}</span>`).join('')}<span>Hechos: ${scenario.stats.done}</span><span>Rechazos: ${scenario.stats.rejected}</span></div>`;
  const acts = { start: 'start', stop: 'stop', refill: 'refill', add: 'add_items' };
  el.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => applyActions([{ type: acts[b.dataset.act], value: 3 }])));
  el.querySelectorAll('[data-sort]').forEach((b) => (b.onclick = () => applyActions([{ type: 'sort_by', mode: b.dataset.sort }])));
  el.querySelectorAll('[data-rule]').forEach((s) => (s.onchange = () => applyActions([{ type: 'set_rule', match: s.dataset.rule, destination: s.value }])));
}

/** Estado de la celda para el cerebro. */
function cellState() {
  if (scenario) return scenario.describe();
  return {
    scenario: 'lab',
    title: 'Celda vacía (sin objetos)',
    robot: { name: robot.spec.name, payload_kg: robot.spec.specs.payload_kg, reach_m: robot.spec.specs.reach_m },
    running: robot.busy,
    destinations: [],
    rules: {},
  };
}

// ------------------------------------------------------------------ acciones

async function applyActions(actions = []) {
  for (const a of actions) {
    switch (a.type) {
      case 'start':
        if (scenario) scenario.start();
        else runDemo();
        break;
      case 'stop':
        scenario?.stop();
        robot.stop();
        setStatus('Parado por el operador', 'error');
        break;
      case 'go_home':
        scenario?.stop();
        robot.goHome();
        break;
      case 'set_rule':
        scenario?.setRule(a.match, a.destination);
        break;
      case 'reset_rules':
        scenario?.resetRules();
        break;
      case 'sort_by':
        scenario?.setSortBy(a.mode ?? 'color');
        break;
      case 'set_speed': {
        const v = Math.max(5, Math.min(100, Math.round(a.value ?? 100)));
        $('override').value = v;
        $('override').oninput();
        break;
      }
      case 'add_items':
        if (scenario?.spawn) for (let i = 0; i < Math.min(a.value ?? 1, 6); i++) scenario.spawn(0.4 - i * 0.12);
        break;
      case 'refill':
        scenario?.refill?.();
        break;
      case 'gesture':
        await playGesture(robot, a.gesture);
        break;
    }
  }
  renderScenarioPanel();
}

async function runDemo() {
  // Cuadrado con la herramienta hacia abajo, escalado al alcance del robot.
  const R = robot.spec.specs.reach_m;
  const h = robot.spec.mount === 'floor' ? 0.25 * R : 0.1 * R;
  const corners = [
    [0.55, -0.22],
    [0.75, -0.22],
    [0.75, 0.22],
    [0.55, 0.22],
    [0.55, -0.22],
  ].map(([x, z], i) => ({ position: new THREE.Vector3(x * R, h, z * R), quaternion: toolDown(i * 30) }));
  setStatus('Demo en curso…', 'busy');
  let r = await robot.moveJTo(corners[0]);
  for (const c of corners.slice(1)) {
    if (!r.ok) break;
    robot.setGripper(robot.gripper.target ? 0 : 1);
    r = await robot.moveL(c, 0.55 * R);
  }
  if (r.ok) await robot.goHome();
  setStatus(r.ok ? READY : r.reason, r.ok ? 'ready' : 'error');
}

// ------------------------------------------------------------------ conversación

const voice = new Voice();
let brain = null;

function addChat(who, text, meta = '') {
  const chat = $('chat');
  const div = document.createElement('div');
  div.className = `msg ${who === 'op' ? 'op' : 'robot'}`;
  div.innerHTML = `${escapeHtml(text)}${meta ? `<span class="meta">${meta}</span>` : ''}`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

const robotName = () => robot.spec.name.replace('ABB ', '');

async function robotSays(text, emotion) {
  addChat('robot', text, emotion);
  presentation.say(robotName(), text);
  await voice.say(text, emotion);
}

async function converse(text) {
  if (!text.trim()) return;
  addChat('op', text);
  presentation.say('Operador', text);
  voice.ack();
  const t0 = performance.now();
  const r = await brain.think(text, cellState());
  const ms = Math.round(performance.now() - t0);
  addChat('robot', r.reply, `${r.emotion} · ${r.source === 'claude' ? 'Claude' : 'local'} · ${ms} ms`);
  presentation.say(robotName(), r.reply);
  const moves = r.actions.some((a) => ['start', 'go_home', 'gesture'].includes(a.type));
  const gesture = !moves && !robot.busy && !scenario?.running ? EMOTION_GESTURE[r.emotion] : null;
  // Habla, actúa y gesticula a la vez: así la respuesta se siente inmediata.
  await Promise.all([voice.say(r.reply, r.emotion), applyActions(r.actions), gesture ? playGesture(robot, gesture) : null]);
}

// Pulsar para hablar (botón del panel, botón de presentación o barra espaciadora).
let session = null;
let partialMsg = null;
async function startListening(btn) {
  if (session || !voice.canListen) return;
  btn.classList.add('listening');
  session = 'starting';
  try {
    session = await voice.listen((partial) => {
      partialMsg ??= addChat('op', '');
      partialMsg.classList.add('partial');
      partialMsg.textContent = partial || '…';
      presentation.say('Operador', partial || '…');
    });
  } catch (err) {
    btn.classList.remove('listening');
    addChat('robot', `No puedo usar el micrófono: ${err.message}`, 'aviso');
    session = null;
  }
}
async function stopListening(btn) {
  btn.classList.remove('listening');
  while (session === 'starting') await new Promise((r) => setTimeout(r, 20));
  if (!session) return;
  const s = session;
  session = null;
  const text = await s.stop();
  partialMsg?.remove();
  partialMsg = null;
  if (text) converse(text);
}
for (const btn of [$('mic'), $('pres-mic')]) {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startListening(btn);
  });
  btn.addEventListener('pointerup', () => stopListening(btn));
  btn.addEventListener('pointerleave', () => session && stopListening(btn));
}
const typing = () => ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && !typing()) {
    e.preventDefault();
    startListening(presentation.active ? $('pres-mic') : $('mic'));
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && !typing()) stopListening(presentation.active ? $('pres-mic') : $('mic'));
});
$('say-form').onsubmit = (e) => {
  e.preventDefault();
  const text = $('say-input').value;
  $('say-input').value = '';
  converse(text);
};

// ------------------------------------------------------------------ presentación

const presentation = new Presentation({
  lab,
  getRobot: () => robot,
  getScenarioTitle: () => SCENARIOS[scenarioKey].title,
});
$('btn-present').onclick = () => {
  presentation.enter();
  if (scenario && !scenario.running) scenario.start();
  else if (!scenario) runDemo();
  setTimeout(() => robotSays(`Hola, soy el ${robotName()}. ${scenario ? 'Empiezo a trabajar.' : 'Te enseño cómo me muevo.'}`, 'excited'), 600);
};
function updatePresentationStats() {
  if (!presentation.active) return;
  const items = scenario ? [['Hechos', scenario.stats.done], ['Rechazos', scenario.stats.rejected], ...scenario.destinations.map((d) => [d.id, d.count])] : [];
  $('pres-stats').innerHTML = items.map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join('');
}
setInterval(updatePresentationStats, 500);

// ------------------------------------------------------------------ controles generales

$('toggle-axes').onclick = (e) => {
  const on = e.currentTarget.classList.toggle('on');
  axesHelpers?.forEach((h) => (h.visible = on));
};
$('reset-view').onclick = resetView;
$('btn-stop').onclick = () => applyActions([{ type: 'stop' }]);
$('btn-home').onclick = () => applyActions([{ type: 'go_home' }]);
$('btn-zero').onclick = () => robot.moveJ(robot.joints.map(() => 0));
$('btn-demo').onclick = () => runDemo();
$('robot-select').onchange = async (e) => {
  const id = e.target.value;
  // Cada escenario tiene su robot; al cambiar de robot se vuelve a la celda vacía.
  await loadRobot(id);
  if (SCENARIOS[scenarioKey].robot && SCENARIOS[scenarioKey].robot !== id) await loadScenario('lab');
};
$('scenario-select').onchange = (e) => loadScenario(e.target.value);

// "Ir a clic": aproximación por encima del punto (MoveJ) y bajada en línea recta (MoveL).
const clickBtn = $('click-mode');
clickBtn.onclick = () => clickBtn.classList.toggle('on');
const marker = buildMarker();
lab.scene.add(marker);
const raycaster = new THREE.Raycaster();
let downAt = null;
viewport.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]));
viewport.addEventListener('pointerup', async (e) => {
  if (!clickBtn.classList.contains('on') || !robot || !downAt || presentation.active) return;
  if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return; // fue un arrastre de cámara
  const rect = lab.renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, lab.camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -robot.root.position.y);
  const hit = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  if (!hit) return;
  const R = robot.spec.specs.reach_m;
  marker.position.copy(hit).add(new THREE.Vector3(0, 0.002, 0));
  marker.scale.setScalar(R / 0.559);
  marker.visible = true;
  const local = robot.root.worldToLocal(hit.clone());
  const above = { position: local.clone().add(new THREE.Vector3(0, 0.2 * R, 0)), quaternion: toolDown(0) };
  const touch = { position: local.clone().add(new THREE.Vector3(0, 0.035 * R, 0)), quaternion: toolDown(0) };
  setStatus('Aproximando…', 'busy');
  let r = await robot.moveJTo(above);
  if (r.ok) r = await robot.moveL(touch, 0.27 * R);
  if (r.ok) r = await robot.moveL(above, 0.45 * R);
  setStatus(r.ok ? READY : r.reason, r.ok ? 'ready' : 'error');
});

function buildMarker() {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xff000f });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.012, 0.016, 32), mat);
  ring.rotation.x = -Math.PI / 2;
  g.add(ring);
  for (const rot of [0, Math.PI / 2]) {
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 0.002), mat);
    bar.rotation.set(-Math.PI / 2, 0, rot);
    g.add(bar);
  }
  g.visible = false;
  return g;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// ------------------------------------------------------------------ bucle

const clock = new THREE.Clock();
lab.renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (physics) physics.step(dt);
  else robot?.update(dt);
  scenario?.update(dt);
  if (presentation.active) presentation.update(dt);
  else lab.controls.update();
  lab.renderer.render(lab.scene, lab.camera);
});

// Acceso desde la consola del navegador para depurar.
window.sim = {
  lab,
  get robot() {
    return robot;
  },
  get scenario() {
    return scenario;
  },
  converse,
  loadScenario,
};

(async () => {
  try {
    const services = await voice.init();
    brain = new Brain(services);
    $('voice-engines').textContent = `${voice.listenEngine ? `Oído: ${voice.listenEngine}` : 'Solo texto'} · Voz: ${services.deepgram ? 'Deepgram' : 'pitidos'} · ${services.claude ? 'Claude' : 'local'}`;
    if (!voice.canListen) $('mic').disabled = true;
    await loadRobot(ROBOTS[0].id);
    await loadScenario('lab');
  } catch (err) {
    console.error(err);
    setStatus('Error al cargar', 'error');
    $('loading').textContent = `Error: ${err.message}`;
  }
})();
