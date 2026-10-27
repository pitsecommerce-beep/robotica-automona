import * as THREE from 'three';

const SHOT_SECONDS = 7;

/**
 * Modo presentación: pantalla completa del laboratorio con cámara cinematográfica que alterna
 * planos (órbita, primer plano de la herramienta, general y contrapicado), subtítulos de la
 * conversación y un rótulo con el robot y el escenario.
 */
export class Presentation {
  constructor({ lab, getRobot, getScenarioTitle }) {
    this.lab = lab;
    this.getRobot = getRobot;
    this.getScenarioTitle = getScenarioTitle;
    this.active = false;
    this.t = 0;
    this.shot = 0;
    this.camPos = new THREE.Vector3();
    this.camTarget = new THREE.Vector3();
    this.overlay = document.getElementById('presentation');
    this.subtitle = document.getElementById('pres-subtitle');
    this.caption = document.getElementById('pres-caption');
    document.getElementById('pres-exit').onclick = () => this.exit();
    window.addEventListener('keydown', (e) => e.key === 'Escape' && this.active && this.exit());
  }

  enter() {
    this.active = true;
    this.t = 0;
    this.shot = 0;
    this.saved = { pos: this.lab.camera.position.clone(), target: this.lab.controls.target.clone() };
    this.camPos.copy(this.lab.camera.position);
    this.camTarget.copy(this.lab.controls.target);
    this.lab.controls.enabled = false;
    document.body.classList.add('presenting');
    const robot = this.getRobot();
    this.caption.innerHTML = `<b>${robot.spec.name}</b><span>${this.getScenarioTitle()}</span>`;
    document.documentElement.requestFullscreen?.().catch(() => {});
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    document.body.classList.remove('presenting');
    this.lab.controls.enabled = true;
    this.lab.camera.position.copy(this.saved.pos);
    this.lab.controls.target.copy(this.saved.target);
    if (document.fullscreenElement) document.exitFullscreen?.();
    this.onExit?.();
  }

  /** Muestra un subtítulo (quién habla y qué dice) durante unos segundos. */
  say(who, text) {
    this.subtitle.innerHTML = `<span class="who">${who}</span>${text}`;
    this.subtitle.classList.add('show');
    clearTimeout(this._sub);
    this._sub = setTimeout(() => this.subtitle.classList.remove('show'), 4500 + text.length * 40);
  }

  update(dt) {
    if (!this.active) return;
    const robot = this.getRobot();
    if (!robot) return;
    this.t += dt;
    if (this.t > SHOT_SECONDS) {
      this.t = 0;
      this.shot = (this.shot + 1) % 4;
    }
    const reach = robot.spec.specs.reach_m;
    const base = robot.root.getWorldPosition(new THREE.Vector3());
    const tcp = robot.getTcpWorld().position;
    const center = base.clone().lerp(tcp, 0.5).add(new THREE.Vector3(0, reach * 0.15, 0));
    const a = this.t / SHOT_SECONDS;
    let pos;
    let target;
    switch (this.shot) {
      case 0: {
        // Órbita lenta alrededor del robot.
        const ang = 0.6 + a * 1.2;
        pos = center.clone().add(new THREE.Vector3(Math.cos(ang) * reach * 2.4, reach * 0.9, Math.sin(ang) * reach * 2.4));
        target = center;
        break;
      }
      case 1: {
        // Primer plano siguiendo la herramienta.
        pos = tcp.clone().add(new THREE.Vector3(reach * 0.55, reach * 0.35, reach * (0.6 - a * 0.4)));
        target = tcp;
        break;
      }
      case 2: {
        // Plano general alto de la celda.
        pos = base.clone().add(new THREE.Vector3(reach * (1.8 - a * 0.3), reach * 2.2, reach * 2.6));
        target = base.clone().add(new THREE.Vector3(reach * 0.4, 0, 0));
        break;
      }
      default: {
        // Contrapicado lateral, más dramático.
        pos = base.clone().add(new THREE.Vector3(reach * (1.6 + a * 0.4), reach * 0.25, -reach * 1.5));
        target = center.clone().add(new THREE.Vector3(0, reach * 0.2, 0));
      }
    }
    const k = 1 - Math.exp(-dt * 1.6); // suavizado de cámara
    this.camPos.lerp(pos, k);
    this.camTarget.lerp(target, k);
    this.lab.camera.position.copy(this.camPos);
    this.lab.controls.target.copy(this.camTarget);
    this.lab.camera.lookAt(this.camTarget);
  }
}
