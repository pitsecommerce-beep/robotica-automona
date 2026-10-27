import { interpretLocally } from './localBrain.js';

const CLOUD_TIMEOUT_MS = 8000;

/**
 * Cerebro del robot. Órdenes claras → intérprete local (respuesta inmediata). Charla u
 * órdenes complejas → Claude, con la celda como contexto. Sin Claude, todo es local.
 */
export class Brain {
  constructor(services) {
    this.services = services;
    this.history = [];
  }

  async think(text, state) {
    const local = interpretLocally(text, state);
    let result = { ...local, source: 'local' };
    if (!(local.confident && local.actions.length) && this.services.claude) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), CLOUD_TIMEOUT_MS);
        const res = await fetch('/api/brain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, state, history: this.history }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (res.ok) result = { ...(await res.json()), source: 'claude' };
      } catch (err) {
        console.warn('Cerebro en la nube no disponible, uso el local', err);
      }
    }
    this.history.push({ role: 'operator', text }, { role: 'robot', text: result.reply });
    this.history = this.history.slice(-12);
    return result;
  }
}
