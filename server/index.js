import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const app = express();

app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    services: {
      claude: Boolean(process.env.ANTHROPIC_API_KEY),
      whisper: Boolean(process.env.OPENAI_API_KEY),
    },
  });
});

// Los GLB no cambian entre despliegues de la misma versión: caché larga.
app.use('/robots', express.static(path.join(dist, 'robots'), { maxAge: '7d' }));
app.use(express.static(dist, { index: false }));
app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Simulador escuchando en http://localhost:${port}`));
