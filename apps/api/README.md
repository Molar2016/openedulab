# apps/api — B2 authentication

Fastify 5 + TypeScript server for the authenticated platform described in
`docs/architecture/A-stage-design.md`. B1 built the skeleton (validated configuration,
checksummed migration runner, `GET /api/healthz`, same-origin SPA hosting). **B2 adds
self-registration, login, logout and sessions.** Resource gating is still B3.

## Status (read this before assuming anything works)

- **Authentication exists; authorization does not.** `POST /api/auth/register`,
  `POST /api/auth/login`, `POST /api/auth/logout` and `GET /api/auth/session` are real:
  scrypt password hashes, server-side revocable sessions, HttpOnly cookie, CSRF checks,
  in-process rate limits.
- Every route that will require a session (`/api/catalog`, `/api/experiments/:id`,
  `/api/me/*`, `/api/events`, `/api/feedback`) is still a placeholder returning
  **401 `unauthenticated` to everybody**, including callers with a valid session. That
  is a denial, not protection: nothing here proves access control yet. B3 replaces the
  placeholders with `requireSession()`.
- `/api/internal/*` is **not mounted at all** (404) — the operator channel arrives later
  with its own Bearer token.
- Client-side deep links (`/experiments/math.functions`) return the public SPA shell for
  everyone. The authenticated deep-link redirect is B3 work, and the SPA in this
  repository is still the **pre-auth prototype** with no login form: there is no
  end-to-end login flow yet, only a working API.
- Sessions are stored in the database and survive a restart; the rate limiter is
  in-process, so it resets on restart and assumes a single instance (design D14/Q6).
- `Secure` + `__Host-oel_sid` are used only when `OEL_ENV=production`. Any HTTPS
  deployment must run in production mode; local http uses `oel_sid` without `Secure`.
- Do not deploy this. `docs/PROJECT_STATE.md` tracks what is actually verified.

## Auth API

| Method | Path | Success | Failure |
|---|---|---|---|
| POST | `/api/auth/register` | `201` + `Set-Cookie` + `{account:{displayHint}}` | 400 validation, 409 `identifier_taken`, 409 `already_authenticated`, 403 CSRF, 429 |
| POST | `/api/auth/login` | `200` + `Set-Cookie` + `{account:{displayHint}}` | 401 `invalid_credentials` (same body for unknown / wrong / disabled), 409 `already_authenticated`, 403 CSRF, 429 |
| POST | `/api/auth/logout` | `204` + cleared cookie | 401 `unauthenticated`, 403 CSRF, 429 |
| GET | `/api/auth/session` | `200 {authenticated:false}` or `{authenticated:true, account:{displayHint, createdAt}}` | 429 |

Rules the tests enforce and that must not regress:

- Identifiers: `loginKind` is `email` or `phone`. Email is trimmed + lowercased
  (≤254 chars, one `@`, dotted domain); phone drops spaces/hyphens/parentheses and keeps
  a leading `+` (7–20 digits). Uniqueness is `(login_kind, normalized_login)`.
- Passwords: 10–128 code points, any characters, not blank. Stored as
  `scrypt$N$r$p$salt$key` (`N=32768, r=8, p=3`, salt 16 B, key 32 B) and upgraded on the
  next successful login when the parameters are older.
- The caller never supplies an account id: unknown JSON properties are rejected (AJV
  `removeAdditional: false`), and every identity is derived from the session cookie.
- Writes require an allowed `Origin` plus a JSON (or absent) content type, and
  `Sec-Fetch-Site` must be `same-origin`/`none` when present. There is no CSRF token
  table; adding a `<form>` submit or a third-party embed requires one first.
- Rate limits (in-process, fixed window): register 5/h per IP and 3/day per identifier;
  login 30/15 min per IP, 10/15 min per identifier+IP, 10 failures then a 15-minute
  lock; session/logout 300/min per IP. Every 429 carries `Retry-After`.

## Layout

```
apps/api/
  src/config.ts          explicit env validation; aggregate errors; fail closed
  src/app.ts             Fastify assembly, error handler, migrations on startup
  src/server.ts          config -> buildApp -> listen (used by src/index.ts)
  src/index.ts           process entry: exit codes, SIGINT/SIGTERM shutdown
  src/db/database.ts     node:sqlite connection + pragmas (WAL, busy_timeout, FK)
  src/db/migrate.ts      numbered + checksummed + per-file transactional migrations
  src/db/account-repository.ts   account queries (SQL stays in the db layer)
  src/db/session-repository.ts   session queries, revocation, invalidation
  src/domain/auth-service.ts     register/login/resolve/revoke: the auth rules
  src/security/identifier.ts     normalization + display masking
  src/security/password.ts       scrypt hash/verify/rehash + dummy verification
  src/security/session-token.ts  random token, sha256 storage form
  src/security/session-policy.ts cookie policy (__Host- in production) + TTLs
  src/security/rate-limit.ts     in-process fixed-window limiter
  src/http/auth-routes.ts        /api/auth/* with schemas, CSRF hook, rate limits
  src/http/csrf.ts               Origin + JSON + Sec-Fetch-Site guard
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

curl -si -X POST http://127.0.0.1:3210/api/auth/register \
  -H 'origin: http://127.0.0.1:3210' -H 'content-type: application/json' \
  -d '{"loginKind":"email","identifier":"you@example.com","password":"a long passphrase"}'
```

See `.env.example` for every variable and its default.

## Invariants

1. **Config fails closed.** Missing/invalid/unknown `OEL_*` values exit 1 with every
   problem listed. Only `OEL_HOST` (`127.0.0.1`) and `OEL_LOG_LEVEL` (`info`) default.
2. **Migrations are append-only.** `NNNN_lower_snake.sql`, sorted numerically, each in
   its own transaction, recorded with a sha256 checksum. Editing an applied file,
   deleting one, or inserting an older one stops startup instead of drifting. B2 needed
   no schema change: `account` and `session` already existed in `0001_init.sql`.
3. **Health never leaks configuration.** It reports version, uptime, and migration
   state only. `degraded` (503) means migration files appeared after startup.
4. **API paths never fall through to the SPA.** Unknown `/api/*` is JSON 404; missing
   assets stay 404; only HTML-accepting GET/HEAD without an asset extension gets
   `index.html`.
5. **Secrets stay out of logs and responses.** The logger redacts `cookie` and
   `authorization`; passwords are never logged, returned or stored reversibly; the raw
   session token exists only in the `Set-Cookie` header.
6. **`apps/api/dist` and local SQLite files are gitignored.**

## Known test-runner caveat

Vite 5 does not recognise the `node:sqlite` builtin and tries to resolve a package
called `sqlite`. `apps/api/vitest.config.ts` aliases `node:sqlite` to
`test/support/sqlite.ts`, which loads the real builtin through `createRequire`. This is
a test-only bridge; runtime code imports `node:sqlite` directly.
