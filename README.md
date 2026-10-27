# OpenEduLab

Interactive teaching experiments for authenticated classrooms. One server process serves
the JSON API and the built SPA from the same origin; sessions live in the database, not in
the client, and every piece of personal data is scoped to the account derived from that
session.

- **Version:** `0.1.0-m1` (B8: engineering candidate for hand-off, *not* a public release)
- **Node:** `>=22.5 <23` (`node:sqlite` is used directly; CI pins `22.23.0`)
- **Source:** public on GitHub — <https://github.com/Molar2016/openedulab> (branch `main`).
- **State:** runs locally, verified end to end; CI runs on GitHub Actions. **No deployment,
  no domain, no public application URL**: this repository is source code only, nothing is
  hosted, so there is no site to open. There is also no licence file yet: on 2026-10-27 the
  owner narrowed the choice to MIT or Apache-2.0 but has not decided, so the code is *not*
  offered under an open-source licence. GitHub Pages is deliberately not enabled — it hosts
  static files only and cannot serve this login-gated server (see
  `docs/ops/deployment-plan.md` §2.1).

Read `docs/PROJECT_STATE.md` first when picking the work up: it records what is done, what
is deliberately absent, the evidence paths and the exact commit for each stage.

## What works today

| Flow | Status | Where it is proven |
|---|---|---|
| Register / sign in / sign out (email or phone) | working, no ownership verification | `apps/api/test/auth.*.test.ts` |
| Server-side sessions, revocation, idle + absolute expiry | working | `apps/api/test/session.test.ts` |
| Single authorization gate for pages and API | working (`requireSession`) | `apps/api/test/authorization.test.ts`, `tests/e2e/gate.spec.ts` |
| Catalog + experiment metadata from a validated content index | working | `apps/api/test/catalog.test.ts`, `experiments.test.ts` |
| Favorites and de-duplicated recent use | working | `apps/api/test/favorites.test.ts`, `recent.test.ts` |
| Whitelisted diagnostics, feedback, operator channel with audit | working | `apps/api/test/events.test.ts`, `feedback.test.ts`, `internal.test.ts` |
| Three-viewport end-to-end (phone / projector / tablet) | working | `tests/e2e/full-flow.spec.ts`, `docs/evidence/b6/` |
| Backup snapshot + restore drill + retention purge | working (local SQLite) | `scripts/backup-check.mjs`, `scripts/restore-check.mjs`, `scripts/retention-purge.mjs` |
| Saved parameter snapshots (B7, semantics revised in R7) | working: explicit save, **automatic** load on entry, one snapshot per (account, experiment) on the direct entry and per (account, placement) on a curriculum chapter; version mismatch falls back to that entry's defaults; two controls only (save / reset) | `apps/api/test/saved-state.test.ts`, `apps/api/test/curriculum.test.ts`, `tests/host-context-state.test.tsx`, `tests/e2e/saved-state.spec.ts` |
| Curriculum contexts (R7, ADR-003) | working slice: one tool in two pilot directory entries (`experiments/math-functions/curriculum.json`), `/curriculum` directory, `/curriculum/<slug>` context page. **Pilot entries are not verified textbook chapters** | `apps/api/test/curriculum.test.ts`, `tests/curriculum-page.test.tsx`, `tests/e2e/curriculum.spec.ts` |
| Password reset, identifier verification | **not implemented** | — |
| Account deletion, personal-data export | **out of scope for v1** (owner decision, 2026-10-27) — not just unimplemented: nothing may claim them | `docs/privacy/launch-readiness.md` §2 |
| CI running on GitHub | **running** (both jobs green on `main`) | run [40350561703](https://github.com/Molar2016/openedulab/actions/runs/40350561703) |

Not-yet-possible claims, stated plainly: there is no production deployment, no domain and
no public URL — the GitHub repository is source only, so no site can be opened. Static
JS/CSS cannot be protected by a login (design §2); the gate protects pages, API responses
and content metadata.

Dependencies: both `npm audit` and `npm audit --omit=dev` report **0 vulnerabilities** as of
the R5 upgrade (`vite` 5→7, `vitest` 2→5, `@vitejs/plugin-react` 4→5, which cleared 6
dev-tool advisories — 2 critical, 1 high, 3 moderate — without touching a single test).
Dependabot alerts are now enabled on the repository; automatic security-update PRs are left
off on purpose. Code scanning is not configured. See `docs/third-party.md`.

## Quick start (local)

```bash
npm ci                     # lockfile is authoritative
npm run build              # SPA -> dist/
npm run build:api          # API  -> apps/api/dist/

OEL_ENV=development OEL_HOST=127.0.0.1 OEL_PORT=3220 \
OEL_PUBLIC_ORIGIN=http://127.0.0.1:3220 \
OEL_DATABASE_PATH=apps/api/data/local.sqlite \
OEL_STATIC_DIR=dist OEL_MIGRATIONS_DIR=apps/api/migrations \
OEL_CONTENT_DIR=experiments OEL_LOG_LEVEL=info \
node apps/api/dist/index.js
```

Open `http://127.0.0.1:3220/` — an anonymous navigation is redirected to `/login`; register
an account and the catalog, the experiment, favorites and "my library" all work.
`GET /api/healthz` reports the version and the applied migration.

`OEL_OPERATOR_TOKEN` (≥16 chars) enables `/api/internal/*`; leave it unset and those routes
are not mounted at all. It is never needed for the user-facing flows.

## Verification

```bash
npm run check        # typecheck (web + api), lint, unit, api, content, build, build:api
npm run smoke:api    # 90 assertions against a real server process on a free port
npm run test:e2e     # Playwright: 4 viewports against the real built SPA (port 3220)
npm run check:backup # VACUUM INTO snapshot + integrity + counts + canary
npm run check:restore# restore the snapshot, boot the API on it, prove a write
npm run retention:dry-run -- --db <path>   # what a purge would delete; changes nothing
npm run ci:local     # the CI job list, run on this machine, in CI order
```

`npm run test:e2e` needs port `3220` free; it starts and stops its own server and its own
throwaway database. If a hand-off instance is still running, stop that PID first (see
`docs/ops/runbook.md`), never "all node processes".

## Layout

```
apps/api/            Fastify API: config, migrations, db access, domain, http
apps/api/migrations  0001_init.sql — the only migration so far
apps/web/            React SPA (session-aware routes, catalog, experiment host, /me)
experiments/         Content: <folder>/manifest.json + locales/{zh-CN,en}.json
                     optional <folder>/state-schema.json declares the savable parameters
scripts/             e2e-server, content validation, backup/restore, retention, status
tests/               web unit tests (vitest) + browser E2E (Playwright)
docs/               requirements, architecture, ops, privacy, evidence per stage
```

## Documentation map

| Need | Document |
|---|---|
| Product requirements v2.1 | `docs/requirements-v2.1.md` |
| Architecture, permission matrix, data & event dictionaries | `docs/architecture/A-stage-design.md` |
| Stage status, commits, evidence, open blockers | `docs/PROJECT_STATE.md` |
| Operate it: env vars, start/stop, health, operator channel, purge | `docs/ops/runbook.md` |
| Test-deployment plan, constraints and pre-flight checklist (blocked: no target) | `docs/ops/deployment-plan.md` |
| Roll back a release | `docs/ops/rollback.md` |
| What personal data exists, where, for how long | `docs/privacy/data-map.md` |
| Before public sign-up: open registration, deletion/export (out of scope for v1), minors (no age gate), and the remaining launch gate | `docs/privacy/launch-readiness.md` |
| Every code dependency actually used | `docs/third-party.md` |
| B8 security/consistency review of B3–B6 | `docs/architecture/review-B8.md` |

## Ground rules for the next stage

- Do not loosen or delete a test to make a gate pass; fix the cause and add a test that
  fails without the fix.
- Do not claim a URL, a green CI run or a deployment that does not exist.
- Production actions (host, DNS, firewall, billing, wider data collection) need the
  project owner's explicit approval, and are outside this repository's local scope.
