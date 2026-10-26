import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import type { AppConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { migrate } from './db/migrate.js';
import { createAuthService } from './domain/auth-service.js';
import { loadContentIndex, type ContentIndex } from './domain/content-index.js';
import { createSessionGate } from './http/auth-context.js';
import { registerAuthRoutes } from './http/auth-routes.js';
import { registerContentRoutes } from './http/content-routes.js';
import { apiError, type ApiErrorCode } from './http/errors.js';
import { registerHealthRoute } from './http/health.js';
import { registerEventRoutes } from './http/event-routes.js';
import { registerInternalRoutes } from './http/internal-routes.js';
import { registerMeRoutes } from './http/me-routes.js';
import { createRouteCollector, exposeRouteInventory } from './http/route-inventory.js';
import { registerSpaGate } from './http/spa-gate.js';
import { registerSpaFallback, registerSpaHosting } from './http/static.js';
import { sessionCookiePolicy } from './security/session-policy.js';

export interface BuildAppOptions {
  readonly config: AppConfig;
  readonly version: string;
  readonly now?: () => number;
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Builds the HTTP app: validates the content index and applies migrations (both
 * fail-closed) before any route exists, then registers the API surface and same-origin
 * SPA hosting.
 *
 * Authorization is wired once, here: a single `AuthService` instance backs both the
 * credential routes and the `requireSession` gate, so "signed in" means the same thing
 * for every route and every HTML navigation.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, version, now = Date.now } = options;

  const app = Fastify({
    logger:
      config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            // Never let a session cookie or bearer token reach a log sink.
            redact: ['req.headers.cookie', 'req.headers.authorization'],
          },
    bodyLimit: MAX_BODY_BYTES,
    trustProxy: false,
    // Reject unknown body properties instead of silently stripping them: a client must
    // never believe it can name an account id, status or hash field.
    ajv: { customOptions: { removeAdditional: false } },
  });

  const routes = createRouteCollector();
  app.addHook('onRoute', routes.record);

  let contentIndex: ContentIndex;
  try {
    contentIndex = loadContentIndex(config.contentDir);
  } catch (error) {
    await app.close();
    throw error;
  }

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
    if (statusCode === 413) {
      return reply
        .code(413)
        .type('application/json; charset=utf-8')
        .send(apiError('payload_too_large', 'Request body is too large.'));
    }
    const mapped: ApiErrorCode =
      statusCode === 401
        ? 'unauthenticated'
        : statusCode === 403
          ? 'forbidden'
          : statusCode === 404
            ? 'not_found'
            : statusCode === 429
              ? 'rate_limited'
              : 'validation_failed';
    return reply
      .code(statusCode)
      .type('application/json; charset=utf-8')
      .send(apiError(mapped, 'Request is invalid.'));
  });

  const sessionService = createAuthService({ db, now });
  const cookiePolicy = sessionCookiePolicy(config);
  const gate = createSessionGate({ service: sessionService, cookiePolicy });

  registerHealthRoute(app, {
    db,
    version,
    migrationsDir: config.migrationsDir,
    startedAt: now(),
    now,
  });
  registerAuthRoutes(app, { config, now, service: sessionService });
  registerContentRoutes(app, { contentIndex, gate });
  registerMeRoutes(app, { config, db, contentIndex, gate, now });
  registerEventRoutes(app, { config, db, contentIndex, gate, now });
  registerInternalRoutes(app, { config, db, contentIndex, now });
  registerSpaGate(app, { gate });
  await registerSpaHosting(app, config.staticDir);
  registerSpaFallback(app);
  exposeRouteInventory(app, routes.entries);

  return app;
}
