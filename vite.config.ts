/// <reference types="vitest" />
import { defineConfig } from 'vite';
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
