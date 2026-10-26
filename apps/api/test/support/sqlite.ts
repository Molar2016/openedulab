import { createRequire } from 'node:module';

/**
 * Test-only bridge for `node:sqlite`.
 *
 * This Vite version (5.x) resolves `node:sqlite` as a bare package called "sqlite"
 * and fails before Node ever sees it. `createRequire` is opaque to Vite, so the real
 * Node builtin is loaded at runtime. Production code imports `node:sqlite` directly;
 * this shim exists only for the test runner.
 */
const require = createRequire(import.meta.url);

type SqliteModule = typeof import('node:sqlite');

const sqlite = require('node:sqlite') as SqliteModule;

export const { DatabaseSync, StatementSync, backup, constants } = sqlite;
export type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
