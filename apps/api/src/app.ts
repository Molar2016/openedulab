import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import type { AppConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { migrate } from './db/migrate.js';
import { apiError } from './http/errors.js';
import { registerHealthRoute } from './http/health.js';
import { registerPrivateRouteStubs } from './http/private-routes.js';
import { registerSpaFallback, registerSpaHosting } from './http/static.js';

export interface BuildAppOptions {
  readonly config: AppConfig;
  readonly version: string;
  readonly now?: () => number;
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Builds the HTTP app: applies migrations (fail-closed) before any route exists,
 * then registers the API surface and same-origin SPA hosting.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, version, now = Date.now } = options;

  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    bodyLimit: MAX_BODY_BYTES,
    trustProxy: false,
  });

  const db = openDatabase(config.databasePath);
  try {
    migrate(db, config.migrationsDir, { now });
  } catch (error) {
    db.close();
    await app.close();
    throw error;
  }

  app.addHook('onClose', async () => {
    db.close();
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    return payload;
  });

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'unhandled request error');
      return reply
        .code(500)
        .type('application/json; charset=utf-8')
        .send(apiError('server_error', 'Internal server error.'));
    }
    const code = statusCode === 413 ? 'payload_too_large' : 'validation_failed';
    return reply
      .code(statusCode)
      .type('application/json; charset=utf-8')
      .send(apiError(code, statusCode === 413 ? 'Request body is too large.' : 'Request is invalid.'));
  });

  registerHealthRoute(app, {
    db,
    version,
    migrationsDir: config.migrationsDir,
    startedAt: now(),
    now,
  });
  registerPrivateRouteStubs(app);
  await registerSpaHosting(app, config.staticDir);
  registerSpaFallback(app);

  return app;
}
