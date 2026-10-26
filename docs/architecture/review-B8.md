# B8 independent review of B3–B6

Scope: permission boundaries, event semantics, data exposure, tests that could pass for the
wrong reason, and contradictions between documents and code. Read-only review first; every
fix below comes with a regression test that fails without it.

Method: read the API surface end to end (`app.ts`, `auth-context.ts`, `content-routes.ts`,
`me-routes.ts`, `event-routes.ts`, `internal-routes.ts`, `spa-gate.ts`, `static.ts`,
`route-inventory.ts`, `config.ts`, `csrf.ts`, `rate-limit.ts`, `db/*`,
`domain/{events,content-index}.ts`, `migrations/0001_init.sql`), the 20 API test files, the 7
E2E specs, and the documents (requirements v2.1, design, roadmap, PROJECT_STATE). Suspected
defects were reproduced before being fixed.

## High risk — fixed in this stage

### H-1 The operator channel authorized after input validation (and let anyone guess for free)

`/api/internal/*` checked the Bearer token *inside each handler*, which runs after Fastify has
validated the query string. Consequences:

- an unauthenticated caller sending `?from=abc` got `400 validation_failed`, while the same
  caller with a valid window got `404 not_found` — a reliable existence oracle for a channel
  that is supposed to be indistinguishable from an unknown path;
- the 60/min budget was consumed only *after* a correct token, so wrong tokens were unlimited.

Fix (`apps/api/src/http/internal-routes.ts`): the check is now a route-level `preValidation`
hook, so it runs before query/param validation and nothing about caller input is inspected
first. Missing/wrong tokens still answer the same 404; a wrong token now spends a per-peer
budget of 10/min and then answers 429 with `Retry-After`. A correct token never consumes that
budget, so an attacker cannot lock the operator out.

Regression tests: `apps/api/test/internal.test.ts` → `describe('the operator channel is gated
before input validation')` — 4 malformed-window 404s, one session-cookie 404, and a
10-free-guesses-then-429 case that also asserts the real token still gets 200.

### H-2 `GET /api/experiments/:id` trusted a caller-controlled `locale`

The route had a params schema but no querystring schema, and the handler indexed
`entry.texts[locale]` directly. Reproduced on the previous commit:

| Request | Old answer | Why |
|---|---|---|
| `?locale=fr` | `500 server_error` | `entry.texts['fr']` is `undefined`, then `text.title` throws |
| `?locale=en-US` | `500 server_error` | same |
| `?locale=__proto__` | `200` with the title/description fields missing | reads `Object.prototype` |
| `?locale=en&limit=5` | `200` (parameter silently ignored) | no `additionalProperties: false` |

A caller-controlled string must not choose which object property is read, and a public
endpoint must not answer 500 for well-formed input. Fix (`content-routes.ts`): an explicit
querystring schema (`locale` enum `zh-CN|en`, `additionalProperties: false`), matching what
`/api/catalog` already did.

Regression tests: `apps/api/test/experiments.test.ts` → 5 locale cases (400), an unknown
parameter case (400), and a positive case proving `locale=en` still returns English while the
default returns Chinese.

## Medium — documentation and copy corrected

### M-1 The in-app privacy text understated what is stored

`about.privacyBody` said the account keeps "a masked identifier". The database keeps the
**full normalized email address or phone number** in `account.normalized_login`; only the API
response and the UI use `display_hint`. Accurate privacy copy matters more than flattering
copy. Fixed in `zh-CN.json` and `en.json`, and stated plainly in
`docs/privacy/data-map.md` §4 (including "we must not claim we never store the identifier").

### M-2 The design listed an HTTP retention endpoint that no longer exists

Design §7.8 still had `POST /api/internal/retention/purge?dryRun=1`. Nothing of the sort is
mounted (correctly — deletion is a CLI action), so the contract was lying about the surface.
Design and runbook now say CLI-only; `apps/api/test/retention.test.ts` asserts that no route
whose URL contains `retention` exists in the inventory.

### M-3 The requirement traceability table pointed at test files that do not exist

Design §11 cited `tests/e2e/auth.spec.ts`, `catalog.spec.ts`, `mobile-projection.spec.ts`,
`locale.spec.ts`, `analytics-off.spec.ts`, `copy.spec.ts`, `no-autosave.spec.ts`,
`apps/api/test/internal-auth.test.ts`, `internal-gaps.test.ts`, `events-sanitize.test.ts`,
`security.test.ts`. None of those paths exist, so "R-05 is covered" could not be verified by
following the table. Remapped to the real files (`gate.spec.ts`, `catalog.test.ts`,
`full-flow.spec.ts`, `app.spec.ts`, `resilience.spec.ts`, `auth.security.test.ts`,
`internal.test.ts`, `events.test.ts`, …).

### M-4 PROJECT_STATE contradicted itself

One paragraph still asserted "`/api/me/*`, `/api/events`, `/api/feedback`, `/api/internal/*`
一律 404", while the B4/B5 sections documented those endpoints as implemented and tested.
Rewritten as an explicitly historical note for B1/B2, with the current state stated once.

### M-5 `me-routes.ts` claimed "four personal-data paths" above a list of three

Comment corrected; the route inventory test remains the source of truth for the count.

## Low — recorded, not changed

| # | Observation | Why it stays |
|---|---|---|
| L-1 | Rate limiting is in-process: a restart clears it and two instances do not share it | accepted single-instance assumption (design §4.5, risk R6). Must change before horizontal scaling. |
| L-2 | `dataGaps` reports only `events_disabled`; a window where ingestion failed mid-way is not detected | needs an ingest-error marker table; explicitly out of scope for the first release, and the aggregate never silently reports such gaps as zero — the field is simply absent. |
| L-3 | CSV exports include the internal `account_id` | required to answer "which account hit this", audited per export, and it is an opaque UUID, not an identifier. |
| L-4 | Static JS/CSS cannot require a session | design §2 accepts this; the gate protects HTML navigations, API responses and content metadata. |
| L-5 | The experiment detail response echoes the whole `manifest` object | it is an authored, reviewed file and the response carries no filesystem path. Rule recorded here: a manifest is data every signed-in account may read — never put a secret or a path in it. A regression test asserts the response contains no absolute path and no `manifest.json` string. |
| L-6 | Retention deletes events with no rollup table, so old trends are unrecoverable | explicit accepted loss (risk R7); stated in the runbook and in `domain/retention.ts`. |

## Test-misjudgment review

Looked for tests that pass without exercising the claim, and for assertions that were weakened
over time:

- **No test was deleted or relaxed in this stage.** All B3–B6 assertions still run: the API
  suite went from 253 to 274 tests (+8 experiment query/path, +7 operator ordering and
  throttling, +6 retention), and the web suite stayed at 90. Exact totals and output:
  `docs/evidence/b8/check-b8.txt`.
- **Skips are explicit and project-scoped** (`test.skip(testInfo.project.name !== …)`), not
  `test.fixme` or swallowed errors. The one capability-based skip is the Fullscreen API check.
- **Counter-proofs exist for the gates** from B2–B5 (`docs/evidence/b2..b5/mutation-*.txt`).
  Two new counter-proofs were produced in this stage: removing the querystring schema and
  moving the operator check back behind validation each turn the new tests red
  (`docs/evidence/b8/mutation-*.txt`).
- **Structural vs behavioural coverage**: the route inventory test proves every `/api` route
  is classified, and `authorization.test.ts` / `private-routes.test.ts` prove anonymous and
  forged callers get 401 on every gated route. That combination is what makes "no route
  bypasses `requireSession`" a checkable claim rather than a reading of the code.
- **Two gaps were real** and are now covered: the operator channel's ordering (H-1) and the
  experiment query schema (H-2). Retention had no tests at all before this stage.

## Verified as sound (no change)

- One authorization point: `requireSession` as `onRequest`, per-request session lookup,
  revocation/expiry/status re-checked, one `AuthService` instance behind both the credential
  routes and the gate.
- Per-account scoping: every personal-data SQL statement is parameterized by the session
  account id; there is no code path that accepts an account id from the request.
- Cross-account de-duplication cannot interfere: `ux_event_dedupe` and
  `ux_event_client_event` are both keyed `(account_id, …)`.
- Event writes carry no UA string, no IP, no free text, no parameter values; enum violations
  are dropped and counted, and a version mismatch is dropped rather than guessed.
- CSRF guard runs before body parsing for writes; healthz exposes no paths or configuration;
  errors are uniformly `{error:{code,message}}` with no stack traces; the logger redacts
  cookie and authorization headers.
- CSV export neutralises leading `=`/`+`/`-`/`@` and omits `received_at` and the user agent.

## Follow-ups that are *not* part of B8

- B7 saved-state (optional, unimplemented — `saved_state` stays empty).
- Self-service account deletion / data export (design Q4) — blocking for public launch.
- Identifier ownership verification and password recovery (design Q5).
- A rollup table before retention destroys trend data, if trends matter.
