import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';

import { getMigrationStatus } from '../db/migrate.js';

export interface HealthDeps {
  readonly db: DatabaseSync;
  readonly version: string;
  readonly migrationsDir: string;
  readonly startedAt: number;
  readonly now?: () => number;
}

interface MigrationSummary {
  applied: number;
  latest: string | null;
  pending: number;
}

/**
 * Public liveness endpoint. It exposes the running version and whether the schema on
 * disk matches the database — never configuration values, paths or credentials.
 * `degraded` means migration files appeared after startup; `error` means the state
 * itself cannot be read.
 */
export function registerHealthRoute(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/api/healthz', async (_request, reply) => {
    const now = deps.now ?? Date.now;
    const at = now();
    const uptimeSeconds = Math.max(0, Math.floor((at - deps.startedAt) / 1000));
    const base = {
      appVersion: deps.version,
      uptimeSeconds,
      timestamp: new Date(at).toISOString(),
    };

    reply.header('cache-control', 'no-store');

    try {
      deps.db.prepare('SELECT 1 AS ok').get();
    } catch {
      return reply.code(503).send({
        status: 'error',
        ...base,
        database: { ok: false, migrations: null },
      });
    }

    let migrations: MigrationSummary;
    try {
      const status = getMigrationStatus(deps.db, deps.migrationsDir);
      migrations = {
        applied: status.applied.length,
        latest: status.latest,
        pending: status.pending.length,
      };
    } catch (error) {
      _request.log.error({ err: error }, 'migration state unavailable');
      return reply.code(503).send({
        status: 'error',
        ...base,
        database: { ok: true, migrations: null },
        error: {
          code: 'migration_state_unavailable',
          message: 'Migration state could not be read; see server logs.',
        },
      });
    }

    const healthy = migrations.pending === 0;
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      ...base,
      database: { ok: true, migrations },
    });
  });
}
