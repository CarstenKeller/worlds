import { defineConfig } from 'vite';

// base './': funktioniert unter https://<user>.github.io/worlds/ und lokal.
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 1500 },
});
