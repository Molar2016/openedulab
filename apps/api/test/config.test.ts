import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config.js';
import { createFixture, envWith, type Fixture } from './helpers.js';

let fixture: Fixture | null = null;

afterEach(async () => {
  if (fixture) {
    await fixture.cleanup();
    fixture = null;
  }
});

async function withFixture(): Promise<Fixture> {
  fixture = await createFixture();
  return fixture;
}

/** Runs loadConfig and returns the reported issue fields; fails when it throws anything else. */
function rejectedFields(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).issues.map((issue) => issue.field);
  }
  throw new Error('expected loadConfig to reject the environment, but it returned a config');
}

describe('loadConfig — fail closed', () => {
  it('normalizes a complete environment', async () => {
    const f = await withFixture();
    const config = loadConfig({ ...f.env, OEL_PUBLIC_ORIGIN: 'http://127.0.0.1:3210/' });

    expect(config).toEqual({
      env: 'test',
      host: '127.0.0.1',
      port: 3210,
      publicOrigin: 'http://127.0.0.1:3210',
      databasePath: f.databasePath,
      migrationsDir: f.migrationsDir,
      staticDir: f.staticDir,
      contentDir: f.env.OEL_CONTENT_DIR,
      logLevel: 'silent',
    });
  });

  it('applies the documented defaults for host and log level only', async () => {
    const f = await withFixture();
    const config = loadConfig(envWith(f.env, { OEL_HOST: undefined, OEL_LOG_LEVEL: undefined }));

    expect(config.host).toBe('127.0.0.1');
    expect(config.logLevel).toBe('info');
  });

  it('reports every missing required variable in one error', async () => {
    const f = await withFixture();
    const fields = rejectedFields(
      envWith(f.env, {
        OEL_ENV: undefined,
        OEL_PORT: undefined,
        OEL_PUBLIC_ORIGIN: undefined,
        OEL_DATABASE_PATH: undefined,
        OEL_STATIC_DIR: undefined,
        OEL_MIGRATIONS_DIR: undefined,
        OEL_CONTENT_DIR: undefined,
      }),
    );

    expect(fields).toEqual(
      expect.arrayContaining([
        'OEL_ENV',
        'OEL_PORT',
        'OEL_PUBLIC_ORIGIN',
        'OEL_DATABASE_PATH',
        'OEL_STATIC_DIR',
        'OEL_MIGRATIONS_DIR',
        'OEL_CONTENT_DIR',
      ]),
    );
  });

  it('rejects a content directory without any <folder>/manifest.json', async () => {
    const f = await withFixture();
    const emptyContent = path.join(f.root, 'empty-content');
    await mkdir(emptyContent, { recursive: true });

    expect(rejectedFields(envWith(f.env, { OEL_CONTENT_DIR: emptyContent }))).toContain(
      'OEL_CONTENT_DIR',
    );
  });

  it.each(['0', '65536', 'abc', '80.5', ''])('rejects invalid OEL_PORT=%j', async (port) => {
    const f = await withFixture();
    expect(rejectedFields(envWith(f.env, { OEL_PORT: port }))).toContain('OEL_PORT');
  });

  it('rejects an unknown OEL_ENV value', async () => {
    const f = await withFixture();
    expect(rejectedFields(envWith(f.env, { OEL_ENV: 'staging' }))).toContain('OEL_ENV');
  });

  it.each([
    'not-a-url',
    'ftp://127.0.0.1:3210',
    'http://127.0.0.1:3210/app',
    'http://127.0.0.1:3210?x=1',
    'http://user:secret@127.0.0.1:3210',
  ])('rejects OEL_PUBLIC_ORIGIN=%j', async (origin) => {
    const f = await withFixture();
    expect(rejectedFields(envWith(f.env, { OEL_PUBLIC_ORIGIN: origin }))).toContain(
      'OEL_PUBLIC_ORIGIN',
    );
  });

  it('rejects a static directory without index.html', async () => {
    const f = await withFixture();
    const emptyDir = path.join(f.root, 'empty-site');
    await mkdir(emptyDir, { recursive: true });

    expect(rejectedFields(envWith(f.env, { OEL_STATIC_DIR: emptyDir }))).toContain(
      'OEL_STATIC_DIR',
    );
  });

  it('rejects a missing static directory', async () => {
    const f = await withFixture();
    expect(
      rejectedFields(envWith(f.env, { OEL_STATIC_DIR: path.join(f.root, 'no-such-site') })),
    ).toContain('OEL_STATIC_DIR');
  });

  it('rejects a migrations directory without any numbered SQL file', async () => {
    const f = await withFixture();
    const emptyMigrations = path.join(f.root, 'empty-migrations');
    await mkdir(emptyMigrations, { recursive: true });

    expect(rejectedFields(envWith(f.env, { OEL_MIGRATIONS_DIR: emptyMigrations }))).toContain(
      'OEL_MIGRATIONS_DIR',
    );
  });

  it('rejects unknown OEL_* variables so typos cannot be silently ignored', async () => {
    const f = await withFixture();
    expect(rejectedFields(envWith(f.env, { OEL_PORTT: '3210' }))).toContain('OEL_PORTT');
  });

  it('rejects :memory: in production but allows it in test', async () => {
    const f = await withFixture();

    expect(
      rejectedFields(envWith(f.env, { OEL_ENV: 'production', OEL_DATABASE_PATH: ':memory:' })),
    ).toContain('OEL_DATABASE_PATH');

    expect(loadConfig(envWith(f.env, { OEL_DATABASE_PATH: ':memory:' })).databasePath).toBe(
      ':memory:',
    );
  });
});
