import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

// vite dev proxy: /api → local orchestrator platform (default :13000).
// Configurable via VITE_API_TARGET (e.g. VITE_API_TARGET=http://localhost:13001).
// cookie/secure: false because dev server is http://localhost, and the auth
// cookie is set by the backend at same-origin via the proxy.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_TARGET || 'http://localhost:13000';

  return {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: false,
          secure: false,
          // ws: false - SSE handled by fetch in SPA, not WebSocket proxy
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  };
});