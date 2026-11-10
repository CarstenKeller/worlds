/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// base './': funktioniert unter https://<user>.github.io/worlds/ und lokal.
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 1500 },
  test: { include: [process.env.LIVE ? 'live/**/*.test.ts' : 'tests/**/*.test.ts'] },
});
