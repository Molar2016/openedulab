import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // This Vite version resolves `node:sqlite` as a bare package named "sqlite" and
  // fails; point it at a test-only shim that loads the real builtin via createRequire.
  resolve: {
    alias: {
      'node:sqlite': fileURLToPath(new URL('./test/support/sqlite.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    restoreMocks: true,
  },
});
