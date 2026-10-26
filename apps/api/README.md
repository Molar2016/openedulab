# apps/api — B1 skeleton

Fastify 5 + TypeScript server for the authenticated platform described in
`docs/architecture/A-stage-design.md`. In B1 it provides only: validated configuration,
a checksummed migration runner, `GET /api/healthz`, and same-origin hosting of the
built SPA.

## Status (read this before assuming anything works)

- **There is no authentication yet.** `POST /api/auth/*` is not mounted (404). B2 adds
  registration/login/logout/session.
- Every route that will require a session (`/api/catalog`, `/api/experiments/:id`,
  `/api/me/*`, `/api/events`, `/api/feedback`) is registered as a placeholder that
  returns **401 `unauthenticated` to everybody**. That is a denial, not protection:
  there is no session layer to check, so nothing here proves access control.
- `/api/internal/*` is **not mounted at all** (404) — the operator channel arrives later
  with its own Bearer token.
- Client-side deep links (`/experiments/math.functions`) return the public SPA shell.
  The authenticated deep-link redirect is B3 work. The SPA in this repository is the
  **pre-auth prototype**; it is not the final login-gated product.
- Do not deploy this. `docs/PROJECT_STATE.md` tracks what is actually verified.

## Layout

```
apps/api/
  src/config.ts          explicit env validation; aggregate errors; fail closed
  src/app.ts             Fastify assembly, error handler, migrations on startup
  src/server.ts          config -> buildApp -> listen (used by src/index.ts)
  src/index.ts           process entry: exit codes, SIGINT/SIGTERM shutdown
  src/db/database.ts     node:sqlite connection + pragmas (WAL, busy_timeout, FK)
  src/db/migrate.ts      numbered + checksummed + per-file transactional migrations
  src/http/health.ts     GET /api/healthz (public)
  src/http/private-routes.ts  401 placeholders for future authenticated routes
  src/http/static.ts     SPA hosting + deep-link fallback (no API fallthrough)
  migrations/0001_init.sql     schema from the A-stage design §5
  test/                  vitest (node environment) suite
  scripts/smoke.mjs      real-process smoke test over HTTP
```

## Commands (run from the repository root)

```bash
npm run typecheck:api     # tsc over src + test (no emit)
npm run test:api          # vitest, apps/api/vitest.config.ts
npm run build:api         # tsc emit to apps/api/dist (gitignored)
npm run start:api         # build + node apps/api/dist/index.js (needs OEL_* vars)
npm run smoke:api         # real process smoke; needs `npm run build` + `build:api`
npm run check             # web + api typecheck, lint, unit, api tests, build
```

Start locally (built SPA is required because `OEL_STATIC_DIR` must contain
`index.html`):

```bash
npm run build
export OEL_ENV=development OEL_PORT=3210 OEL_PUBLIC_ORIGIN=http://127.0.0.1:3210 \
       OEL_DATABASE_PATH=apps/api/data/openedulab.sqlite OEL_STATIC_DIR=dist \
       OEL_MIGRATIONS_DIR=apps/api/migrations
npm run start:api
curl -s http://127.0.0.1:3210/api/healthz
```

See `.env.example` for every variable and its default.

## Invariants

1. **Config fails closed.** Missing/invalid/unknown `OEL_*` values exit 1 with every
   problem listed. Only `OEL_HOST` (`127.0.0.1`) and `OEL_LOG_LEVEL` (`info`) default.
2. **Migrations are append-only.** `NNNN_lower_snake.sql`, sorted numerically, each in
   its own transaction, recorded with a sha256 checksum. Editing an applied file,
   deleting one, or inserting an older one stops startup instead of drifting.
3. **Health never leaks configuration.** It reports version, uptime, and migration
   state only. `degraded` (503) means migration files appeared after startup.
4. **API paths never fall through to the SPA.** Unknown `/api/*` is JSON 404; missing
   assets stay 404; only HTML-accepting GET/HEAD without an asset extension gets
   `index.html`.
5. **`apps/api/dist` and local SQLite files are gitignored.**

## Known test-runner caveat

Vite 5 does not recognise the `node:sqlite` builtin and tries to resolve a package
called `sqlite`. `apps/api/vitest.config.ts` aliases `node:sqlite` to
`test/support/sqlite.ts`, which loads the real builtin through `createRequire`. This is
a test-only bridge; runtime code imports `node:sqlite` directly.
