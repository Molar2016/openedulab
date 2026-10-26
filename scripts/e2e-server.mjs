#!/usr/bin/env node
/**
 * Local E2E server for Playwright (B3+).
 *
 * Starts the *real* API process serving the *real* built SPA, so the browser exercises
 * the same artifact that would ship: same-origin hosting, session cookies, the resource
 * gate and the deep-link redirect. Nothing is mocked.
 *
 * Isolation: a throwaway SQLite database under test-results/, deleted before every run,
 * so registrations and favorites never leak between runs and the in-process rate limiter
 * always starts empty.
 *
 * Port 3220 — deliberately not the API test port (3210) nor the old Vite dev port (5199).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PORT = 3220;
const OPERATOR_TOKEN = 'e2e-local-operator-token-not-a-secret';
const DATA_DIR = join(ROOT, 'test-results', 'e2e');
const DB_PATH = join(DATA_DIR, 'app.sqlite');

function run(command) {
  const result = spawnSync(command, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) {
    console.error(`[e2e] build step failed: ${command}`);
    process.exit(result.status ?? 1);
  }
}

// Always build: a stale bundle would make the browser test a different app than the code.
run('npm run build');
run('npm run build:api');

mkdirSync(DATA_DIR, { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  rmSync(`${DB_PATH}${suffix}`, { force: true });
}

if (!existsSync(join(ROOT, 'dist', 'index.html')) || !existsSync(join(ROOT, 'apps/api/dist/index.js'))) {
  console.error('[e2e] build output missing after build step');
  process.exit(1);
}

const child = spawn(process.execPath, [join(ROOT, 'apps', 'api', 'dist', 'index.js')], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    OEL_ENV: 'test',
    OEL_HOST: '127.0.0.1',
    OEL_PORT: String(PORT),
    OEL_PUBLIC_ORIGIN: `http://127.0.0.1:${PORT}`,
    OEL_DATABASE_PATH: DB_PATH,
    OEL_STATIC_DIR: join(ROOT, 'dist'),
    OEL_MIGRATIONS_DIR: join(ROOT, 'apps', 'api', 'migrations'),
    OEL_CONTENT_DIR: join(ROOT, 'experiments'),
    // Local, ephemeral, test-only operator token. It protects a throwaway process on
    // 127.0.0.1 with a database that is deleted on every run; it is not a secret and must
    // never be reused as a real deployment token.
    OEL_OPERATOR_TOKEN: OPERATOR_TOKEN,
    OEL_LOG_LEVEL: 'warn',
  },
});

const shutdown = (signal) => {
  child.kill(signal);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
child.on('exit', (code) => {
  process.exit(code ?? 0);
});
