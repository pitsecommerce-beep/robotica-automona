/**
 * Gestos expresivos: secuencias articulares cortas alrededor de la postura de Home, siempre
 * dentro de los límites y velocidades reales del robot. Cada robot declara qué eje hace de
 * "giro" (yaw), "cabeceo" (pitch), "brazo" (lift) y "muñeca" (roll) en robot.json.
 */
const SEQUENCES = {
  // Celebración: balanceo lateral rápido, muñeca girando y pinza abriendo y cerrando.
  celebrate: { speed: 1, gripper: true, poses: [{ yaw: 25, roll: 60, lift: -8 }, { yaw: -25, roll: -60, lift: -8 }, { yaw: 25, roll: 60, lift: -8 }, { yaw: -25, roll: -60, lift: -8 }, {}] },
  nod: { speed: 0.7, poses: [{ pitch: 18 }, { pitch: -6 }, { pitch: 18 }, {}] },
  shake: { speed: 0.7, poses: [{ yaw: 14 }, { yaw: -14 }, { yaw: 14 }, { yaw: -14 }, {}] },
  wave: { speed: 0.9, poses: [{ lift: -15, pitch: -20, roll: 45 }, { lift: -15, pitch: -20, roll: -45 }, { lift: -15, pitch: -20, roll: 45 }, { lift: -15, pitch: -20, roll: -45 }, {}] },
  think: { speed: 0.35, hold: 900, poses: [{ yaw: 10, pitch: 12, roll: 20 }, {}] },
  bow: { speed: 0.4, hold: 600, poses: [{ lift: 15, pitch: 25 }, {}] },
  sad: { speed: 0.2, hold: 1200, poses: [{ lift: 12, pitch: 35, yaw: -8 }, {}] },
  curious: { speed: 0.5, hold: 500, poses: [{ yaw: -12, roll: 25, pitch: 10 }, { yaw: 12, roll: -25, pitch: 10 }, {}] },
};

export const EMOTION_GESTURE = {
  excited: 'celebrate',
  happy: 'nod',
  proud: 'wave',
  curious: 'curious',
  confused: 'shake',
  sad: 'sad',
  thinking: 'think',
  neutral: null,
};

export const GESTURES = Object.keys(SEQUENCES);

export async function playGesture(robot, name) {
  const seq = SEQUENCES[name];
  if (!seq || robot.busy) return false;
  const axes = robot.spec.gestures?.axes ?? {};
  const scale = robot.spec.gestures?.scale ?? 1;
  const home = robot.joints.map((j) => robot.spec.home_deg?.[j.name] ?? 0);
  const index = Object.fromEntries(robot.joints.map((j, i) => [j.name, i]));
  const prevOverride = robot.speedOverride;
  robot.speedOverride = Math.min(1, seq.speed);
  try {
    await robot.moveJ(home);
    for (const [k, pose] of seq.poses.entries()) {
      const target = home.slice();
      for (const [role, deg] of Object.entries(pose)) {
        const i = index[axes[role]];
        if (i !== undefined) target[i] += deg * scale;
      }
      if (seq.gripper) robot.setGripper(k % 2 ? 0 : 1);
      await robot.moveJ(target);
      if (seq.hold && k === 0) await new Promise((r) => setTimeout(r, seq.hold));
    }
    robot.setGripper(0);
  } finally {
    robot.speedOverride = prevOverride;
  }
  return true;
}
