/** Panel de movimiento manual estilo FlexPendant: un deslizador por eje, TCP y pinza. */
export function createPendant(robot) {
  const jointsEl = document.getElementById('joints');
  jointsEl.innerHTML = '';
  const rows = robot.joints.map((j, i) => {
    const min = (j.min * 180) / Math.PI;
    const max = (j.max * 180) / Math.PI;
    const row = document.createElement('div');
    row.className = 'joint';
    row.innerHTML = `
      <label>${j.label}</label><span class="val">0.0°</span>
      <input type="range" min="${min}" max="${max}" step="0.5" value="0" />
      <div class="lim"><span>${min.toFixed(1)}°</span><span>${(j.vmax * 180 / Math.PI).toFixed(0)}°/s</span><span>${max.toFixed(1)}°</span></div>`;
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

  const tcpEl = document.getElementById('tcp');
  const gripVal = document.getElementById('grip-val');
  let frame = 0;
  robot.onUpdate(() => {
    if (frame++ % 3) return; // refrescar el panel a ~20 Hz basta
    robot.getJointsDeg().forEach((v, i) => {
      rows[i].val.textContent = `${v.toFixed(1)}°`;
      if (document.activeElement !== rows[i].input) rows[i].input.value = v;
    });
    const p = robot.getTcpMm();
    if (p) {
      tcpEl.innerHTML = ['X', 'Y', 'Z']
        .map((k, i) => `<div><span>${k}</span><b>${[p.x, -p.z, p.y][i].toFixed(1)}</b></div>`)
        .join('');
    }
    gripVal.textContent = `${(robot.gripper.opening * robot.gripper.stroke * 2000).toFixed(1)} mm`;
  });
}
