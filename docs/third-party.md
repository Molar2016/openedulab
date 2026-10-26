# Third-party code inventory

Only what the shipped code and its test/build tooling actually import. Versions are the ones
locked in `package-lock.json` on this machine (2026-10-27, after the R5 security upgrade). Asset
licensing (images, fonts,
external experiment material) is **not** covered here: the first experiments are original to
this project, and any future external asset needs its own review before it ships
(`docs/requirements-v2.1.md` §5).

## Runtime dependencies (4)

| Package | Version | Licence | Why it is here |
|---|---|---|---|
| `fastify` | 5.12.7 | MIT | the HTTP server: routing, JSON schema validation (AJV), hooks, logging with redaction |
| `@fastify/static` | 10.1.7 | MIT | same-origin hosting of the built SPA; pinned to the patched major after four high-severity path-traversal advisories in 8.3.0 (`npm audit --omit=dev` = 0) |
| `react` | 18.3.1 | MIT | the SPA: catalog, experiment host, `/me`, login pages |
| `react-dom` | 18.3.1 | MIT | DOM renderer for React |

SQLite is **not** a package: the API uses Node's built-in `node:sqlite` (`DatabaseSync`),
which is why `package.json` pins `engines` to `>=22.5 <23`. It is marked experimental by Node;
consequences and the mitigation (all SQL confined to `apps/api/src/db/`) are in the design
document §8.2.

## Development / test tooling (18)

| Package | Version | Licence | Role |
|---|---|---|---|
| `typescript` | 5.9.3 | Apache-2.0 | typechecking for web and API (`tsc --noEmit`) |
| `vite` | 7.3.7 | MIT | SPA build (`dist/`) and the web test transform (see "Known advisories" for why 7 and not 8) |
| `vitest` | 5.0.5 | MIT | web and API unit/integration runner |
| `@vitejs/plugin-react` | 5.2.0 | MIT | JSX transform |
| `jsdom` | 25.0.1 | MIT | DOM environment for component tests |
| `@testing-library/react` | 16.3.3 | MIT | component testing |
| `@testing-library/user-event` | 14.6.8 | MIT | realistic user interactions in tests |
| `@testing-library/jest-dom` | 6.9.1 | MIT | DOM matchers |
| `@playwright/test` | 1.64.1 | Apache-2.0 | browser E2E over four viewports |
| `eslint` | 9.39.5 | MIT | linting |
| `@eslint/js` | 9.39.5 | MIT | ESLint's own recommended config |
| `typescript-eslint` | 8.72.0 | MIT | TypeScript parser/plugin for ESLint |
| `eslint-plugin-react-hooks` | 5.2.0 | MIT | hook rules |
| `eslint-plugin-react-refresh` | 0.4.26 | MIT | fast-refresh boundary rule |
| `globals` | 15.15.0 | MIT | browser/node global declarations for ESLint |
| `@types/node` | 26.6.5 | MIT | typings |
| `@types/react` | 18.3.31 | MIT | typings |
| `@types/react-dom` | 18.3.7 | MIT | typings |

## Not present, on purpose

- No analytics, telemetry, error-reporting or font/CDN SDK. The SPA talks only to its own
  origin (`tests/e2e/app.spec.ts` asserts there is no cross-origin request).
- No ORM, no query builder: SQL is written by hand inside `apps/api/src/db/` against the
  portable subset documented in the design §8.4.
- No cache, queue, Redis or reverse-proxy library in the process; the single-instance
  assumptions (in-process rate limiting, sessions in the database) are recorded as risk R6.
- No CSS framework: `styles.css` is hand-written.

## Project licence: **not chosen** (owner decision pending)

There is no `LICENSE` file in this repository and none may be added by anyone but the project
owner. On 2026-10-27 the owner narrowed the candidates to **MIT** or **Apache-2.0** but did
not pick one, so the decision is recorded as open:

| Aspect | MIT | Apache-2.0 |
|---|---|---|
| Text length | ~170 words | ~11 kB |
| Patent grant | none (silent on patents) | explicit grant + termination on patent litigation |
| Trademark clause | none | explicit (§6) |
| Notice/attribution | one copyright line | NOTICE file conventions, change notices |
| Fit here | simplest, common for small teaching tools | safer if schools/companies ever embed it |

Until one is chosen and committed **with** the owner's name and year, the correct statements
are: "source is public to read", "no licence has been granted", and "do not redistribute".
README and the in-app `about.licensePending` string already say the licence is not final.

## Updating a dependency

1. `npm install <pkg>@<version>` (updates `package-lock.json`).
2. `npm run ci:local` — the full CI step list on this machine.
3. For a security fix, add or extend a regression test that fails on the previous version
   when the advisory is behavioural (this is what the `@fastify/static` traversal payloads
   in `apps/api/test/static.test.ts` are for).
4. Record the change in `docs/PROJECT_STATE.md` with the commit SHA.

## Known advisories (R5, 2026-10-27)

**Current state: `npm audit` → 0 vulnerabilities; `npm audit --omit=dev` → 0 vulnerabilities.**
Evidence: `docs/evidence/r5/audit-before.txt` (before) and `docs/evidence/r5/audit-after.txt`
(after); both are real command output on this machine.

Before the R5 upgrade the same commands reported **6** (2 critical, 1 high, 3 moderate), all in
the front-end dev toolchain:

| Package | Severity | Direct | Advisory | Fixed by |
|---|---|---|---|---|
| `tinypool` | critical | no | prototype pollution → RCE in the test worker (GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr) | `vitest` 2 → 5 |
| `vitest` | critical | yes | file read / mock-registration injection via the UI + dev server | `vitest` 2 → 5 |
| `vite` | high | yes | dev-server path traversal, `server.fs.deny` bypass on Windows, launch-editor arg handling | `vite` 5 → 7 |
| `@vitest/mocker`, `vite-node` | moderate | no | dev-server only (GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8) | `vitest` 2 → 5 |
| `esbuild` | moderate | no | any site could proxy requests through the dev server (GHSA-67mh-4wv8-2f99) | `vite` 5 → 7 (esbuild 0.28.2) |

### Why `vite` 7 and not 8

`npm audit fix --force` would have installed `vite@8` + `vitest@5`. Vite 8 replaces
esbuild/Rollup with **Rolldown/Oxc** — a bundler rewrite, i.e. a build-output change to verify
across four viewports, for no security benefit over 7: the advisories above are cleared at
`vite >= 7` (`esbuild ^0.27 || ^0.28`, no vulnerable `esbuild`, and `vitest@5` requires
`vite >= 6.4`). The smallest combination that is actually safe is therefore:

- `vite` 5.4.21 → **7.3.7** (still Rollup + esbuild; `engines: ^20.19 || >=22.12` — satisfied
  by Node 22.23.0 in CI and locally)
- `vitest` 2.1.9 → **5.0.5** (requires Node ≥ 22.12 and `vite ≥ 6.4`; peer satisfied)
- `@vitejs/plugin-react` 4.7.0 → **5.2.0** (peer `vite ^4 || ^5 || ^6 || ^7 || ^8`)

Moving to Vite 8 is a separate, deliberate change (bundler swap + re-verification), not a
security fix, and is recorded as a follow-up rather than done here.

### Two config changes the upgrade forced (both in `vite.config.ts`)

1. **Config typing.** `/// <reference types="vitest" />` + `defineConfig` from `vite` no longer
   types the `test` block (TS2769: `'test' does not exist in type 'UserConfigExport'`). The
   config now imports `defineConfig` from `vitest/config`, which re-exports Vite's own and types
   `test`. This is the documented Vitest 5 shape; `vite build` reads the same file.
2. **Browser target pinned, deliberately.** Vite 7's default `build.target` is
   `baseline-widely-available` (Chrome 111 / Safari 16.4); Vite 5's default was the `modules`
   set (Chrome 87 / Edge 88 / Firefox 78 / Safari 14). Left alone, a *security* bump would have
   silently raised the browser floor for exactly the audience this product targets (classroom
   and projector machines, often old). `build.target` is therefore pinned to the Vite 5 set, so
   the support surface is unchanged; raising it stays a product decision with its own check.

### What the upgrade did *not* do

No test was deleted, skipped or loosened; no assertion was relaxed; no dependency was pinned to
a vulnerable version to keep a test green. Identical suites pass before and after: web 10 files /
122 tests, API 23 files / 330 tests, smoke 108/108 checks, Playwright 78 passed / 52 skipped /
0 failed (`docs/evidence/r5/check-before.txt` vs `check-after.txt`, `smoke.txt`, `e2e.txt`).

GitHub-side alerting: **Dependabot alerts were disabled and are now enabled** on the
repository (2026-10-27: `PUT /repos/…/vulnerability-alerts` → 204; read back `GET` → 204;
before that both `vulnerability-alerts` and `dependabot/alerts` answered 404/403 "disabled").
Dependabot **security updates** (auto-PRs) remain **off** — `automated-security-fixes` →
`{"enabled":false,"paused":false}` — because automatic PRs are noise the owner has not asked
for; turning them on is an owner decision.

What the alerts actually said, and why the count differs from npm: enabling the alerts opened
**4** immediately against the committed lockfile (`vite` ×2, `vitest`, `esbuild`); after the
upgraded lockfile was pushed (`eee74a2`) GitHub rescanned and **all 15 advisory×package alerts
are `state=fixed`, 0 open**. GitHub opens one alert per advisory per package (15, 14 distinct
GHSA ids, against `vite@5.4.21` ×8, `vitest@2.1.9` ×4, `tinypool@1.1.1` ×2, `esbuild@0.21.5`),
while `npm audit` groups one row per package (6). Same dev-tool chain, two granularities; both
now clean. Raw API transcript: `docs/evidence/r5/dependabot-alerts.txt`.

Secret scanning and push protection stay enabled with 0 alerts; code scanning is still not
configured (no analysis), which is not the same as "scanning passed".

