import type { FastifyInstance } from 'fastify';

import { apiError } from './errors.js';

interface PrivateRouteStub {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly url: string;
}

/**
 * Routes from docs/architecture/A-stage-design.md §7 that will require a session in
 * B2/B3. Until the auth layer exists they deny every caller, so no endpoint can be
 * mistaken for an unauthenticated resource. This is a placeholder, not protection:
 * it proves the route shape exists and fails closed.
 */
export const PRIVATE_ROUTE_STUBS: readonly PrivateRouteStub[] = [
  { method: 'GET', url: '/api/catalog' },
  { method: 'GET', url: '/api/experiments/:experimentId' },
  { method: 'GET', url: '/api/me/favorites' },
  { method: 'PUT', url: '/api/me/favorites/:experimentId' },
  { method: 'DELETE', url: '/api/me/favorites/:experimentId' },
  { method: 'GET', url: '/api/me/recent' },
  { method: 'POST', url: '/api/me/recent' },
  { method: 'GET', url: '/api/me/saved-state/:experimentId' },
  { method: 'PUT', url: '/api/me/saved-state/:experimentId' },
  { method: 'DELETE', url: '/api/me/saved-state/:experimentId' },
  { method: 'POST', url: '/api/events' },
  { method: 'POST', url: '/api/feedback' },
];

const DENIAL_MESSAGE =
  'Authentication is not implemented yet; this endpoint currently denies all requests.';

export function registerPrivateRouteStubs(app: FastifyInstance): void {
  for (const route of PRIVATE_ROUTE_STUBS) {
    app.route({
      method: route.method,
      url: route.url,
      handler: async (_request, reply) => {
        reply.header('cache-control', 'no-store');
        return reply.code(401).send(apiError('unauthenticated', DENIAL_MESSAGE));
      },
    });
  }
}
