import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const demo = process.env.VITE_DEMO === '1';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.API_URL ?? 'http://localhost:4000', changeOrigin: true } },
  },
  build: {
    target: 'es2022',
    sourcemap: !demo,
    // The demo ships as one self-contained file, so code-splitting is turned off for it.
    ...(demo ? { outDir: 'dist-demo', assetsInlineLimit: 1e9, rollupOptions: { output: { inlineDynamicImports: true } } } : {}),
  },
});
