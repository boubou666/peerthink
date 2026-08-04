import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs, so the built site works from a sub-path
  // (GitHub Pages serves this under /peerthink/).
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
