/**
 * Voz de robot con pitidos (estilo droide), sintetizada con Web Audio. Es la voz por defecto
 * cuando no hay Deepgram configurado y el "carácter" que precede a cada respuesta hablada.
 * El patrón depende de la emoción y la longitud del mensaje.
 */
let ctx = null;

function audio() {
  ctx ??= new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

const rand = (a, b) => a + Math.random() * (b - a);

// Cada patrón devuelve una lista de notas { f0, f1 (glissando), dur, gap, type, vibrato }.
const PATTERNS = {
  excited: (n) => [
    ...Array.from({ length: n + 3 }, () => ({ f0: rand(900, 1800), f1: rand(1800, 3200), dur: rand(0.04, 0.08), gap: 0.02, type: 'square' })),
    { f0: 1400, f1: 3400, dur: 0.25, gap: 0, type: 'sine', vibrato: 30 },
  ],
  happy: (n) =>
    Array.from({ length: n + 1 }, (_, i) => ({ f0: i % 2 ? 1500 : 1000, f1: i % 2 ? 1100 : 1700, dur: 0.09, gap: 0.04, type: 'triangle' })),
  proud: (n) => [
    ...Array.from({ length: n }, (_, i) => ({ f0: 800 + i * 150, f1: 900 + i * 180, dur: 0.1, gap: 0.03, type: 'triangle' })),
    { f0: 1600, f1: 2000, dur: 0.3, gap: 0, type: 'sine', vibrato: 12 },
  ],
  curious: (n) => [
    ...Array.from({ length: n }, () => ({ f0: rand(700, 1100), f1: rand(1000, 1500), dur: 0.07, gap: 0.05, type: 'sine' })),
    { f0: 900, f1: 2400, dur: 0.22, gap: 0, type: 'sine' },
  ],
  confused: (n) => [
    ...Array.from({ length: n }, () => ({ f0: rand(500, 900), f1: rand(400, 1200), dur: rand(0.08, 0.14), gap: 0.03, type: 'sawtooth', vibrato: 40 })),
    { f0: 600, f1: 1500, dur: 0.3, gap: 0, type: 'triangle', vibrato: 25 },
  ],
  sad: () => [
    { f0: 900, f1: 500, dur: 0.5, gap: 0.08, type: 'sine', vibrato: 6 },
    { f0: 600, f1: 260, dur: 0.8, gap: 0, type: 'sine', vibrato: 5 },
  ],
  thinking: (n) => Array.from({ length: n }, () => ({ f0: rand(1200, 1600), f1: rand(1200, 1600), dur: 0.03, gap: 0.12, type: 'sine' })),
  neutral: (n) => Array.from({ length: n }, () => ({ f0: rand(800, 1500), f1: rand(800, 1600), dur: rand(0.06, 0.1), gap: 0.05, type: 'triangle' })),
};

/** Reproduce pitidos para un texto y una emoción. Devuelve la duración en segundos. */
export function beep(emotion = 'neutral', text = '') {
  const ac = audio();
  const words = text.split(/\s+/).filter(Boolean).length;
  const n = Math.max(2, Math.min(9, Math.round(words / 2.5)));
  const notes = (PATTERNS[emotion] ?? PATTERNS.neutral)(n);
  const out = ac.createGain();
  out.gain.value = 0.12;
  out.connect(ac.destination);
  let t = ac.currentTime + 0.02;
  for (const note of notes) {
    const osc = ac.createOscillator();
    const env = ac.createGain();
    osc.type = note.type;
    osc.frequency.setValueAtTime(note.f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, note.f1), t + note.dur);
    if (note.vibrato) {
      const lfo = ac.createOscillator();
      const depth = ac.createGain();
      lfo.frequency.value = 18;
      depth.gain.value = note.vibrato;
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + note.dur);
    }
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.008);
    env.gain.setValueAtTime(1, t + note.dur - 0.015);
    env.gain.linearRampToValueAtTime(0, t + note.dur);
    osc.connect(env).connect(out);
    osc.start(t);
    osc.stop(t + note.dur + 0.01);
    t += note.dur + note.gap;
  }
  return t - ac.currentTime;
}

/** Desbloquea el audio tras un gesto del usuario (requisito de los navegadores). */
export function unlockAudio() {
  audio();
}
