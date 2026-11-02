import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const demo = process.env.VITE_DEMO === '1';

export default defineConfig({
  // The demo is served from a sub-path (GitHub Pages), so it uses relative asset URLs.
  base: demo ? './' : '/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.API_URL ?? 'http://localhost:4000', changeOrigin: true } },
  },
  build: {
    target: 'es2022',
    sourcemap: !demo,
    ...(demo ? { outDir: 'dist-demo' } : {}),
  },
});
