# Third-party code inventory

Only what the shipped code and its test/build tooling actually import. Versions are the ones
locked in `package-lock.json` on this machine (2026-10-26). Asset licensing (images, fonts,
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
| `vite` | 5.4.21 | MIT | SPA build (`dist/`) and the web test transform |
| `vitest` | 2.1.9 | MIT | web and API unit/integration runner |
| `@vitejs/plugin-react` | 4.7.0 | MIT | JSX transform |
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

## Known advisories (reviewed 2026-10-26, run 40350561703 baseline)

`npm audit --omit=dev` → **0 vulnerabilities**: nothing in the shipped dependency set
(`fastify`, `@fastify/static`, `react`, `react-dom`) is flagged.

`npm audit` (devDependencies included) → **6**: 2 critical, 1 high, 3 moderate, all in the
front-end dev toolchain and all fixed only by a major bump (`vite` 5→8, `vitest` 2→5):

| Package | Severity | Direct | What it affects |
|---|---|---|---|
| `vitest` | critical | yes | Vitest UI/dev-server file read and mock-registration injection |
| `tinypool` (via vitest) | critical | no | prototype-pollution → RCE inside the test worker |
| `vite` | high | yes | dev-server path traversal, `server.fs.deny` bypass on Windows, launch-editor arg handling |
| `@vitest/mocker`, `vite-node` | moderate | no | dev-server only |
| `esbuild` (via vite) | moderate | no | dev-server request proxying |

Why this is recorded rather than fixed tonight: every advisory is reachable only through a
**development** server or the Vitest UI (`--ui` is never used), and `vite.config.ts` binds
`127.0.0.1` only; the production artefact is static files plus the Fastify process, which
do not run any of these. Fixing them means a major-version migration of the whole test
harness, which is a separate, verifiable stage — not a change to slip into another gate.
Do not read this as "the repository is clean": it is clean for runtime dependencies and
has known dev-tool advisories, tracked here.

GitHub-side alerting: **Dependabot alerts and Dependabot security updates are disabled** on
the repository (checked via the API: HTTP 403 "Dependabot alerts are disabled"); secret
scanning and push protection are enabled and currently report 0 alerts; code scanning is
not configured ("no analysis found"). Enabling Dependabot is a repository-settings change
that needs the owner's approval — until then GitHub is not watching dependencies, and this
local audit is the evidence.

