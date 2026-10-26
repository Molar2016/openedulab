// Vitest 5 no longer augments Vite's own `UserConfig` via `/// <reference types="vitest" />`;
// `vitest/config` re-exports Vite's `defineConfig` with the `test` field typed, and is what
// the build (`vite build`) reads as well — one config for both.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Local M1 slice: static-first SPA. No proxy, no backend, no analytics network calls.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: false,
  },
  preview: {
    host: '127.0.0.1',
    port: 5199,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Vite 7's default target is `baseline-widely-available` (Chrome 111 / Safari 16.4),
    // which would silently raise the browser floor relative to Vite 5's `modules` default
    // (these four). Classroom/projector machines are exactly where old browsers survive, so
    // the security upgrade must not narrow support as a side effect. Raising this is a
    // product decision with its own verification, not a free win from a dependency bump.
    target: ['chrome87', 'edge88', 'firefox78', 'safari14'],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    css: false,
    include: ['tests/**/*.test.{ts,tsx}', 'experiments/**/tests/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
