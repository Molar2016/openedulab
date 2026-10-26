import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const SPA_MARKER = 'data-fixture="spa-shell"';

export const INDEX_HTML = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '  <head><meta charset="utf-8" /><title>OpenEduLab fixture</title></head>',
  `  <body><div id="root" ${SPA_MARKER}></div><script type="module" src="/assets/app.js"></script></body>`,
  '</html>',
  '',
].join('\n');

export interface Fixture {
  root: string;
  staticDir: string;
  migrationsDir: string;
  databasePath: string;
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}

/**
 * Creates an isolated temp workspace: built-SPA fixture, migrations dir with one
 * valid migration, and a database path whose parent directory does not exist yet
 * (the server must create it).
 */
export async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'oel-api-'));
  const staticDir = path.join(root, 'site');
  const migrationsDir = path.join(root, 'migrations');
  const databasePath = path.join(root, 'data', 'app.sqlite');

  await mkdir(path.join(staticDir, 'assets'), { recursive: true });
  await writeFile(path.join(staticDir, 'index.html'), INDEX_HTML, 'utf8');
  await writeFile(path.join(staticDir, 'assets', 'app.js'), 'console.log("oel-app");\n', 'utf8');

  await mkdir(migrationsDir, { recursive: true });
  await writeFile(
    path.join(migrationsDir, '0001_init.sql'),
    'CREATE TABLE first (id TEXT PRIMARY KEY);\n',
    'utf8',
  );

  return {
    root,
    staticDir,
    migrationsDir,
    databasePath,
    env: baseEnv({ staticDir, migrationsDir, databasePath }),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export interface EnvPaths {
  staticDir: string;
  migrationsDir: string;
  databasePath: string;
}

export function baseEnv(paths: EnvPaths): Record<string, string> {
  return {
    OEL_ENV: 'test',
    OEL_HOST: '127.0.0.1',
    OEL_PORT: '3210',
    OEL_PUBLIC_ORIGIN: 'http://127.0.0.1:3210',
    OEL_DATABASE_PATH: paths.databasePath,
    OEL_STATIC_DIR: paths.staticDir,
    OEL_MIGRATIONS_DIR: paths.migrationsDir,
    OEL_LOG_LEVEL: 'silent',
  };
}

/** Builds an env object from a fixture with keys removed/overridden. */
export function envWith(
  base: Record<string, string>,
  overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

export async function writeMigration(
  dir: string,
  name: string,
  sql: string,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, sql, 'utf8');
  return file;
}
