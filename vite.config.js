import { defineConfig } from 'vite';

// En desarrollo, las rutas /api (incluido el WebSocket de voz) van al servidor Express.
export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
  server: {
    proxy: { '/api': { target: 'http://localhost:3000', ws: true } },
  },
});
