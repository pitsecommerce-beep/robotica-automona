// Proxy hacia Deepgram: la clave nunca sale del servidor.
import { WebSocket, WebSocketServer } from 'ws';

const DG = 'https://api.deepgram.com/v1';
const STT_MODEL = process.env.DEEPGRAM_STT_MODEL || 'nova-3';
const TTS_MODEL = process.env.DEEPGRAM_TTS_MODEL || 'aura-2-nestor-es';

export const voiceAvailable = () => Boolean(process.env.DEEPGRAM_API_KEY);

const auth = () => ({ Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` });

/** Audio grabado en el navegador → texto. */
export async function transcribe(audio, contentType) {
  const url = `${DG}/listen?model=${STT_MODEL}&language=es&smart_format=true&punctuate=true`;
  const res = await fetch(url, { method: 'POST', headers: { ...auth(), 'Content-Type': contentType || 'audio/webm' }, body: audio });
  if (!res.ok) throw new Error(`Deepgram STT ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
}

/** Texto → audio MP3 (Aura) como stream: el navegador empieza a reproducir con los primeros bytes. */
export async function synthesizeStream(text) {
  const res = await fetch(`${DG}/speak?model=${TTS_MODEL}&encoding=mp3`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Deepgram TTS ${res.status}: ${await res.text()}`);
  return res.body;
}

/**
 * Transcripción en vivo: el navegador envía audio por WebSocket mientras el operador habla y
 * este proxy lo reenvía a Deepgram, devolviendo resultados parciales y finales al instante.
 */
export function attachLiveTranscription(server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/api/listen') || !voiceAvailable()) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (client) => {
      const params = new URLSearchParams({
        model: STT_MODEL,
        language: 'es',
        smart_format: 'true',
        interim_results: 'true',
        endpointing: '250',
      });
      const dg = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, { headers: auth() });
      const pending = [];
      dg.on('open', () => pending.splice(0).forEach((m) => dg.send(m.data, { binary: m.binary })));
      dg.on('message', (data) => client.readyState === WebSocket.OPEN && client.send(data.toString()));
      dg.on('close', () => client.close());
      dg.on('error', (err) => {
        console.error('Deepgram live', err.message);
        client.close(1011, 'deepgram');
      });
      client.on('message', (data, binary) => {
        if (dg.readyState === WebSocket.OPEN) dg.send(data, { binary });
        else pending.push({ data, binary });
      });
      client.on('close', () => {
        if (dg.readyState === WebSocket.OPEN) dg.send(JSON.stringify({ type: 'CloseStream' }));
      });
    });
  });
}
