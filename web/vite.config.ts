import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `vite build` -> web/dist (served by `npm run cli -- serve`).
// `vite build --mode single` -> web/dist-single/index.html, one file used by `report` to export a shareable page.
export default defineConfig(({ mode }) => ({
  root: __dirname,
  plugins: mode === 'single' ? [react(), viteSingleFile()] : [react()],
  build: { outDir: mode === 'single' ? 'dist-single' : 'dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:8787' } },
}));
