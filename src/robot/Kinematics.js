import * as THREE from 'three';

const DEG = Math.PI / 180;

/**
 * Cinemática directa e inversa en el marco de la base (metros, Y arriba). Sin dependencias de
 * la escena para poder usarla en Node y en tests.
 *
 * Distingue los ejes motorizados (q, los del FlexPendant) de las articulaciones del mecanismo:
 * cada articulación de la cadena hasta el TCP gira una combinación lineal de q. Así se modelan
 * tanto brazos serie (YuMi: identidad) como paletizadores con paralelogramo (IRB 660: el eje 3
 * es absoluto y la muñeca se mantiene horizontal).
 *
 * La pose de la herramienta es { position: Vector3, quaternion: Quaternion }, donde el marco
 * de la herramienta tiene Z = dirección de aproximación e Y = eje de apertura de los dedos.
 */
export class Kinematics {
  constructor(kin, spec) {
    this.joints = kin.actuated.map((name) => {
      const lim = spec.joints[name];
      return { name, min: lim.min_deg * DEG, max: lim.max_deg * DEG, vmax: lim.max_speed_dps * DEG };
    });
    this.n = this.joints.length;
    const index = Object.fromEntries(kin.actuated.map((name, i) => [name, i]));

    // Cadena desde la base hasta el eslabón de la herramienta.
    const byName = Object.fromEntries(kin.links.map((l) => [l.name, l]));
    const chain = [];
    for (let l = byName[kin.tool.link]; l; l = byName[l.parent]) chain.unshift(l);
    this.chain = chain.map((l) => {
      if (!l.drive.q) throw new Error(`El eslabón ${l.name} de la cadena principal debe depender solo de los ejes`);
      const coeff = new Float64Array(this.n);
      for (const [name, c] of Object.entries(l.drive.q)) coeff[index[name]] = c;
      return { name: l.name, origin: new THREE.Vector3(...l.origin), axis: new THREE.Vector3(...l.axis).normalize(), coeff };
    });

    this.coupled = (spec.coupled_limits ?? []).map((c) => ({
      i: index[c.joints[0]],
      j: index[c.joints[1]],
      polygon: c.polygon_deg.map(([a, b]) => [a * DEG, b * DEG]),
    }));

    const tool = kin.tool;
    this.tcpFlange = new THREE.Vector3(...tool.tcp);
    this.approachHome = new THREE.Vector3(...tool.approach_axis).normalize();
    this.tcpHome = this.tcpFlange.clone();
    // Orientación de la herramienta en la pose cero: columnas X, Y (dedos), Z (aproximación).
    const z = new THREE.Vector3(...tool.approach_axis).normalize();
    const y = new THREE.Vector3(...tool.finger_axis).normalize();
    const x = new THREE.Vector3().crossVectors(y, z);
    this.toolHomeQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    this.rest = this.joints.map((j) => (spec.home_deg?.[j.name] ?? 0) * DEG);
    // Un brazo de menos de 6 ejes no controla la orientación completa: solo el giro sobre la vertical.
    this.fullOrientation = this.n >= 6;
  }

  /** Herramienta montada: desplaza el TCP a lo largo de la dirección de aproximación. */
  setToolLength(m) {
    this.tcpHome = this.tcpFlange.clone().addScaledVector(this.approachHome, m);
  }

  /** Ángulo de cada articulación de la cadena para los ejes q. */
  chainAngles(q) {
    return this.chain.map((c) => c.coeff.reduce((s, k, i) => s + k * q[i], 0));
  }

  /** Marcos de cada articulación de la cadena y pose del TCP para q (rad). */
  forward(q) {
    const angles = this.chainAngles(q);
    const frames = [];
    const R = new THREE.Quaternion();
    const p = new THREE.Vector3();
    let prev = new THREE.Vector3();
    const step = new THREE.Quaternion();
    this.chain.forEach((c, i) => {
      // El origen de la articulación se desplaza con la rotación acumulada de los eslabones anteriores.
      p.add(c.origin.clone().sub(prev).applyQuaternion(R));
      frames.push({ origin: p.clone(), axis: c.axis.clone().applyQuaternion(R) });
      R.multiply(step.setFromAxisAngle(c.axis, angles[i]));
      prev = c.origin;
    });
    const position = p.clone().add(this.tcpHome.clone().sub(prev).applyQuaternion(R));
    const quaternion = R.clone().multiply(this.toolHomeQ);
    return { frames, position, quaternion };
  }

  /** Lleva q dentro de los límites de cada eje y de los límites combinados (polígonos). */
  clamp(q) {
    q.forEach((v, i) => (q[i] = Math.min(this.joints[i].max, Math.max(this.joints[i].min, v))));
    for (const c of this.coupled) {
      const [a, b] = projectToPolygon([q[c.i], q[c.j]], c.polygon);
      q[c.i] = a;
      q[c.j] = b;
    }
    return q;
  }

  /** ¿q respeta todos los límites? */
  withinLimits(q, tol = 1e-6) {
    const c = this.clamp(q.slice());
    return c.every((v, i) => Math.abs(v - q[i]) < tol);
  }

  /**
   * IK por mínimos cuadrados amortiguados con tarea secundaria en el espacio nulo
   * (el eje redundante mantiene una postura cómoda, cerca de Home).
   * Devuelve { q, ok, posErr, rotErr } en rad, m y rad.
   */
  inverse(target, seed, { maxIter = 150, posTol = 2e-4, rotTol = 0.2 * DEG, orientation = true } = {}) {
    const seeds = [seed, this.rest, ...randomSeeds(this, 6)];
    // La semilla actual va primero: si converge, la solución queda cerca de la postura actual.
    let best = null;
    for (const s of seeds) {
      const r = this._solve(target, s, maxIter, posTol, rotTol, orientation);
      if (r.ok) return r;
      if (!best || r.cost < best.cost) best = r;
    }
    return best;
  }

  /** IK local desde una semilla, sin reintentos: para seguir trayectorias de forma continua. */
  track(target, seed) {
    return this._solve(target, seed, 60, 2e-4, 0.2 * DEG, true);
  }

  _solve(target, seed, maxIter, posTol, rotTol, useRot) {
    const n = this.n;
    const q = this.clamp(seed.slice());
    const m = useRot ? 6 : 3;
    let posErr = Infinity;
    let rotErr = Infinity;
    for (let it = 0; it < maxIter; it++) {
      const fk = this.forward(q);
      const ep = target.position.clone().sub(fk.position);
      const er = useRot ? rotationError(target.quaternion, fk.quaternion) : new THREE.Vector3();
      posErr = ep.length();
      rotErr = er.length();
      if (posErr < posTol && (!useRot || rotErr < rotTol)) break;

      // Jacobiano geométrico (m × n): por articulación, lineal = a × (p - o) y angular = a;
      // cada eje motorizado suma las columnas de las articulaciones que mueve.
      const J = [];
      for (let r = 0; r < m; r++) J.push(new Float64Array(n));
      fk.frames.forEach((f, c) => {
        const lin = f.axis.clone().cross(fk.position.clone().sub(f.origin));
        const col = useRot ? [lin.x, lin.y, lin.z, f.axis.x, f.axis.y, f.axis.z] : [lin.x, lin.y, lin.z];
        const coeff = this.chain[c].coeff;
        for (let i = 0; i < n; i++) {
          if (coeff[i]) for (let r = 0; r < m; r++) J[r][i] += coeff[i] * col[r];
        }
      });
      // Pasos limitados para que la linealización siga siendo válida.
      const maxP = 0.05;
      const maxR = 0.3;
      const sp = posErr > maxP ? maxP / posErr : 1;
      const sr = rotErr > maxR ? maxR / rotErr : 1;
      const e = useRot ? [ep.x * sp, ep.y * sp, ep.z * sp, er.x * sr, er.y * sr, er.z * sr] : [ep.x * sp, ep.y * sp, ep.z * sp];

      // Amortiguamiento alto lejos del objetivo (estabilidad) y bajo cerca (precisión).
      const lambda = posErr > 0.01 || rotErr > 5 * DEG ? 0.02 : 0.002;
      const Jp = dampedPinv(J, n, m, lambda); // n × m
      const dq = new Float64Array(n);
      for (let i = 0; i < n; i++) for (let r = 0; r < m; r++) dq[i] += Jp[i][r] * e[r];

      // Espacio nulo: (I - J⁺J)·k·(q_reposo - q), y alejarse de los topes.
      const z = q.map((qi, i) => {
        const j = this.joints[i];
        const mid = (j.min + j.max) / 2;
        const span = j.max - j.min;
        return 0.1 * (this.rest[i] - qi) + 0.05 * ((mid - qi) / span);
      });
      for (let i = 0; i < n; i++) {
        let s = z[i];
        for (let k = 0; k < n; k++) {
          let jpj = 0;
          for (let r = 0; r < m; r++) jpj += Jp[i][r] * J[r][k];
          s -= jpj * z[k];
        }
        dq[i] += s;
      }
      for (let i = 0; i < n; i++) q[i] += dq[i];
      this.clamp(q);
    }
    const ok = posErr < posTol * 5 && (!useRot || rotErr < rotTol * 5);
    return { q, ok, posErr, rotErr, cost: posErr + 0.1 * rotErr };
  }
}

/** Vector de rotación (eje·ángulo) que lleva de la orientación actual a la deseada. */
function rotationError(qTarget, qCurrent) {
  const d = qTarget.clone().multiply(qCurrent.clone().invert());
  if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
  const s = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
  if (s < 1e-9) return new THREE.Vector3();
  const angle = 2 * Math.atan2(s, d.w);
  return new THREE.Vector3(d.x, d.y, d.z).multiplyScalar(angle / s);
}

/** J⁺ = Jᵀ (J Jᵀ + λ² I)⁻¹, con J de m × n. */
function dampedPinv(J, n, m, lambda) {
  const A = [];
  for (let r = 0; r < m; r++) {
    A.push(new Float64Array(m));
    for (let c = 0; c < m; c++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += J[r][k] * J[c][k];
      A[r][c] = s + (r === c ? lambda * lambda : 0);
    }
  }
  const Ainv = invert(A, m);
  const P = [];
  for (let i = 0; i < n; i++) {
    P.push(new Float64Array(m));
    for (let c = 0; c < m; c++) {
      let s = 0;
      for (let r = 0; r < m; r++) s += J[r][i] * Ainv[r][c];
      P[i][c] = s;
    }
  }
  return P;
}

/** Inversa por Gauss-Jordan con pivoteo parcial (matrices pequeñas, simétricas definidas positivas). */
function invert(A, m) {
  const M = A.map((row, r) => {
    const out = new Float64Array(2 * m);
    out.set(row);
    out[m + r] = 1;
    return out;
  });
  for (let c = 0; c < m; c++) {
    let piv = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    for (let k = 0; k < 2 * m; k++) M[c][k] /= d;
    for (let r = 0; r < m; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f) for (let k = 0; k < 2 * m; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row) => row.slice(m));
}

// Semillas pseudoaleatorias deterministas: el mismo objetivo da siempre la misma solución.
function randomSeeds(kin, count) {
  let state = 12345;
  const rnd = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
  return Array.from({ length: count }, () =>
    kin.joints.map((j, i) => kin.rest[i] + (rnd() - 0.5) * Math.min(j.max - j.min, 2.4)),
  );
}

/** Orientación con la herramienta apuntando hacia abajo y los dedos girados `yawDeg` sobre la vertical. */
export function toolDown(yawDeg = 0) {
  const yaw = yawDeg * DEG;
  const z = new THREE.Vector3(0, -1, 0);
  const y = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const x = new THREE.Vector3().crossVectors(y, z);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** Conversión entre el marco de la escena (Y arriba) y el marco de base ABB (Z arriba, X adelante). */
export const abbFromScene = (v) => ({ x: v.x, y: -v.z, z: v.y });
export const sceneFromAbb = ({ x, y, z }) => new THREE.Vector3(x, z, -y);

/** Punto más cercano dentro de un polígono convexo (vértices en orden). */
function projectToPolygon(p, poly) {
  let inside = true;
  let sign = 0;
  for (let k = 0; k < poly.length; k++) {
    const [ax, ay] = poly[k];
    const [bx, by] = poly[(k + 1) % poly.length];
    const cross = (bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax);
    if (Math.abs(cross) < 1e-12) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) inside = false;
  }
  if (inside) return p;
  let best = null;
  let bestD = Infinity;
  for (let k = 0; k < poly.length; k++) {
    const [ax, ay] = poly[k];
    const [bx, by] = poly[(k + 1) % poly.length];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy)));
    const c = [ax + t * dx, ay + t * dy];
    const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}
