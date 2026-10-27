import * as THREE from 'three';
import { toolDown, abbFromScene, sceneFromAbb } from '../robot/Kinematics.js';

/**
 * Panel de movimiento estilo FlexPendant: jog articular, movimiento cartesiano (MoveJ/MoveL),
 * jog cartesiano por pasos, pinza y lectura del TCP. Coordenadas en el marco de base ABB (mm).
 */
export function createPendant(robot, { onStatus }) {
  const jointsEl = document.getElementById('joints');
  jointsEl.innerHTML = '';
  const rows = robot.joints.map((j, i) => {
    const min = j.min / THREE.MathUtils.DEG2RAD;
    const max = j.max / THREE.MathUtils.DEG2RAD;
    const row = document.createElement('div');
    row.className = 'joint';
    row.innerHTML = `
      <label>${j.label}</label><span class="val">0.0°</span>
      <input type="range" min="${min}" max="${max}" step="0.5" value="0" />
      <div class="lim"><span>${min.toFixed(1)}°</span><span>${(j.vmax / THREE.MathUtils.DEG2RAD).toFixed(0)}°/s</span><span>${max.toFixed(1)}°</span></div>`;
    const input = row.querySelector('input');
    input.addEventListener('input', () => robot.jogDeg(i, Number(input.value)));
    jointsEl.appendChild(row);
    return { input, val: row.querySelector('.val') };
  });

  const override = document.getElementById('override');
  const overrideVal = document.getElementById('override-val');
  override.oninput = () => {
    robot.speedOverride = Number(override.value) / 100;
    overrideVal.textContent = `${override.value} %`;
  };
  override.oninput();

  document.getElementById('grip-open').onclick = () => robot.setGripper(1);
  document.getElementById('grip-close').onclick = () => robot.setGripper(0);

  // --- Movimiento cartesiano
  const inputs = ['x', 'y', 'z', 'yaw'].map((k) => document.getElementById(`cart-${k}`));
  const orient = document.getElementById('cart-orient');
  const speed = document.getElementById('cart-speed');

  const fillFromTcp = () => {
    const { position } = robot.getTcpPose();
    const p = abbFromScene(position);
    inputs[0].value = (p.x * 1000).toFixed(1);
    inputs[1].value = (p.y * 1000).toFixed(1);
    inputs[2].value = (p.z * 1000).toFixed(1);
  };
  const targetPose = () => {
    const [x, y, z, yaw] = inputs.map((el) => Number(el.value));
    const position = sceneFromAbb({ x: x / 1000, y: y / 1000, z: z / 1000 });
    const quaternion = orient.value === 'down' ? toolDown(yaw) : robot.getTcpPose().quaternion;
    return { position, quaternion };
  };
  const exec = (label, promise) => {
    onStatus(`${label} en curso…`);
    promise.then((r) => onStatus(r.ok ? null : `${label}: ${r.reason}`, !r.ok));
  };

  document.getElementById('cart-read').onclick = fillFromTcp;
  document.getElementById('cart-movej').onclick = () => exec('MoveJ', robot.moveJTo(targetPose()));
  document.getElementById('cart-movel').onclick = () => exec('MoveL', robot.moveL(targetPose(), Number(speed.value) / 1000));

  // Jog cartesiano: pequeños MoveL manteniendo la orientación actual.
  const stepSel = document.getElementById('jog-step');
  document.querySelectorAll('[data-jog]').forEach((btn) => {
    btn.onclick = () => {
      if (robot.busy) return;
      const [axis, sign] = [btn.dataset.jog[1], btn.dataset.jog[0] === '+' ? 1 : -1];
      const pose = robot.getTcpPose();
      const d = { x: 0, y: 0, z: 0 };
      d[axis] = (sign * Number(stepSel.value)) / 1000;
      pose.position.add(sceneFromAbb(d));
      exec('Jog', robot.moveL(pose, 0.1));
    };
  });

  const tcpEl = document.getElementById('tcp');
  const gripVal = document.getElementById('grip-val');
  let last = 0;
  robot.onUpdate(() => {
    const now = performance.now();
    if (now - last < 50) return; // refrescar el panel a ~20 Hz basta
    last = now;
    robot.getJointsDeg().forEach((v, i) => {
      rows[i].val.textContent = `${v.toFixed(1)}°`;
      if (document.activeElement !== rows[i].input) rows[i].input.value = v;
    });
    const p = abbFromScene(robot.getTcpPose().position);
    tcpEl.innerHTML = ['x', 'y', 'z'].map((k) => `<div><span>${k.toUpperCase()}</span><b>${(p[k] * 1000).toFixed(1)}</b></div>`).join('');
    gripVal.textContent = `${(robot.gripper.opening * robot.gripper.stroke * 2000).toFixed(1)} mm`;
  });

  fillFromTcp();
  return { fillFromTcp };
}
