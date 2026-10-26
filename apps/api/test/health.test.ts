import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createFixture, writeMigration, type Fixture } from './helpers.js';

let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  if (fixture) {
    await fixture.cleanup();
    fixture = null;
  }
});

async function start(overrides: Record<string, string> = {}): Promise<FastifyInstance> {
  fixture = await createFixture();
  const config = loadConfig({ ...fixture.env, ...overrides });
  app = await buildApp({ config, version: '9.9.9-test' });
  return app;
}

describe('GET /api/healthz', () => {
  it('reports the running version and applied migration state without authentication', async () => {
    const server = await start();

    const response = await server.inject({ method: 'GET', url: '/api/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.headers['cache-control']).toBe('no-store');

    const body = response.json();
    expect(body).toMatchObject({
      status: 'ok',
      appVersion: '9.9.9-test',
      database: { ok: true, migrations: { applied: 1, latest: '0001', pending: 0 } },
    });
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it('does not leak configuration or filesystem paths', async () => {
    const server = await start();

    const response = await server.inject({ method: 'GET', url: '/api/healthz' });
    const raw = response.body;

    expect(raw).not.toContain(fixture!.databasePath.replace(/\\/g, '\\\\'));
    expect(raw).not.toContain('OEL_');
    expect(raw.toLowerCase()).not.toContain('password');
    expect(raw.toLowerCase()).not.toContain('token');
  });

  it('degrades to 503 when a migration file appears after startup', async () => {
    const server = await start();
    await writeMigration(fixture!.migrationsDir, '0002_add_second.sql', 'CREATE TABLE second (id TEXT);\n');

    const response = await server.inject({ method: 'GET', url: '/api/healthz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      database: { ok: true, migrations: { applied: 1, latest: '0001', pending: 1 } },
    });
  });

  it('fails closed at startup when a migration cannot be applied', async () => {
    fixture = await createFixture();
    await writeMigration(fixture.migrationsDir, '0002_broken.sql', 'THIS IS NOT SQL;\n');
    const config = loadConfig(fixture.env);

    await expect(buildApp({ config, version: '9.9.9-test' })).rejects.toThrow(/0002/);
  });
});
