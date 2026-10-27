import { beep, unlockAudio } from './beeps.js';

/**
 * Entrada y salida de voz.
 * - Escuchar: Deepgram en vivo por WebSocket (texto parcial mientras se habla); si no está
 *   configurado, el reconocimiento de voz del navegador; si tampoco hay, solo texto.
 * - Hablar: Deepgram Aura en streaming precedido de un pitido; sin Deepgram, solo pitidos.
 */
export class Voice {
  constructor() {
    this.services = { claude: false, deepgram: false };
    this.audio = new Audio();
    this.muted = false;
  }

  async init() {
    try {
      this.services = (await (await fetch('/api/health')).json()).services;
    } catch {
      // Sin servidor (p. ej. vista estática): todo local.
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.browserSR = SR ?? null;
    return this.services;
  }

  get canListen() {
    return this.services.deepgram || Boolean(this.browserSR);
  }

  get listenEngine() {
    return this.services.deepgram ? 'Deepgram' : this.browserSR ? 'navegador' : null;
  }

  /**
   * Empieza a escuchar. onPartial recibe el texto provisional. Devuelve { stop } y stop()
   * resuelve con el texto final (rápido: la transcripción ya va hecha al soltar).
   */
  async listen(onPartial) {
    unlockAudio();
    return this.services.deepgram ? this._listenDeepgram(onPartial) : this._listenBrowser(onPartial);
  }

  async _listenDeepgram(onPartial) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/listen`);
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const queue = [];
    let finals = '';
    let interim = '';
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      if (ws.readyState === WebSocket.OPEN) ws.send(e.data);
      else queue.push(e.data);
    };
    ws.onopen = () => queue.splice(0).forEach((b) => ws.send(b));
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;
      if (msg.is_final) {
        if (alt.transcript) finals = `${finals} ${alt.transcript}`.trim();
        interim = '';
      } else interim = alt.transcript;
      onPartial?.(`${finals} ${interim}`.trim());
    };
    rec.start(100); // trozos de 100 ms: Deepgram transcribe mientras se habla
    const closed = new Promise((r) => (ws.onclose = r));
    return {
      stop: async () => {
        rec.stop();
        stream.getTracks().forEach((t) => t.stop());
        await new Promise((r) => setTimeout(r, 120)); // último trozo de audio
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }));
        // Deepgram devuelve el resultado final en unos cientos de ms; no esperar más de 1,5 s.
        await Promise.race([closed, new Promise((r) => setTimeout(r, 1500))]);
        ws.close();
        return `${finals} ${interim}`.trim();
      },
    };
  }

  async _listenBrowser(onPartial) {
    const sr = new this.browserSR();
    sr.lang = 'es-ES';
    sr.interimResults = true;
    sr.continuous = true;
    let finals = '';
    let interim = '';
    sr.onresult = (e) => {
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finals = `${finals} ${r[0].transcript}`.trim();
        else interim += r[0].transcript;
      }
      onPartial?.(`${finals} ${interim}`.trim());
    };
    const ended = new Promise((r) => (sr.onend = r));
    sr.start();
    return {
      stop: async () => {
        sr.stop();
        await Promise.race([ended, new Promise((r) => setTimeout(r, 800))]);
        return `${finals} ${interim}`.trim();
      },
    };
  }

  /** Reacción inmediata al terminar de escuchar, mientras el cerebro piensa. */
  ack() {
    if (!this.muted) beep('thinking', 'a b c d e');
  }

  /** Dice el texto: pitido con la emoción y, si hay Deepgram, voz sintetizada en streaming. */
  async say(text, emotion = 'neutral') {
    if (this.muted || !text) return;
    const chirp = beep(emotion, this.services.deepgram ? 'ok' : text);
    if (!this.services.deepgram) return wait(chirp * 1000);
    await wait(Math.min(chirp, 0.35) * 1000);
    try {
      this.audio.src = `/api/tts?text=${encodeURIComponent(text)}`;
      await this.audio.play();
      await new Promise((r) => {
        this.audio.onended = r;
        this.audio.onerror = r;
      });
    } catch {
      beep(emotion, text); // si falla la voz, el robot no se queda mudo
    }
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
