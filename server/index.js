import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { brainAvailable, think } from './brain.js';
import { Readable } from 'node:stream';
import { voiceAvailable, transcribe, synthesizeStream, attachLiveTranscription } from './voice.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const app = express();

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, services: { claude: brainAvailable(), deepgram: voiceAvailable() } });
});

app.post('/api/stt', express.raw({ type: () => true, limit: '10mb' }), async (req, res) => {
  if (!voiceAvailable()) return res.status(503).json({ error: 'Deepgram no configurado' });
  try {
    res.json({ text: await transcribe(req.body, req.headers['content-type']) });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

// GET para que un <audio> lo reproduzca en streaming mientras llega.
app.get('/api/tts', async (req, res) => {
  if (!voiceAvailable()) return res.status(503).json({ error: 'Deepgram no configurado' });
  const text = String(req.query.text ?? '').slice(0, 600);
  if (!text) return res.status(400).json({ error: 'Texto vacío' });
  try {
    const body = await synthesizeStream(text);
    res.type('audio/mpeg');
    Readable.fromWeb(body).pipe(res);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/brain', express.json({ limit: '256kb' }), async (req, res) => {
  if (!brainAvailable()) return res.status(503).json({ error: 'Claude no configurado' });
  const { text, state, history } = req.body ?? {};
  if (!text) return res.status(400).json({ error: 'Falta la orden' });
  try {
    res.json(await think({ text: String(text).slice(0, 1000), state, history }));
  } catch (err) {
    console.error(err);
    const status = err instanceof Anthropic.RateLimitError ? 429 : 502;
    res.status(status).json({ error: err.message });
  }
});

// Los GLB no cambian entre despliegues de la misma versión: caché larga.
app.use('/robots', express.static(path.join(dist, 'robots'), { maxAge: '7d' }));
app.use(express.static(dist, { index: false }));
app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => console.log(`Simulador escuchando en http://localhost:${port}`));
attachLiveTranscription(server);
