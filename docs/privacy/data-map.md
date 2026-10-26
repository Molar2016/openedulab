# Privacy data map

What OpenEduLab stores, where it comes from, who can read it, and how long it lives. This
is written against `apps/api/migrations/0001_init.sql` and the code paths that write each
table — not against intent.

Principle from the requirement baseline: personal favourites/history are a **reliable
feature**; diagnostics are **best effort**. They live in different tables, are written by
different endpoints, and a diagnostics outage must never touch the first two.

## 1. Tables and fields

### `account` — who can sign in

| Column | Content | Notes |
|---|---|---|
| `id` | random UUIDv4 | the only account key used internally |
| `login_kind` | `email` \| `phone` | which namespace the identifier belongs to |
| `normalized_login` | **the full email address or phone number**, trimmed/lower-cased | needed to sign in. Never returned by the API; the UI only ever sees `display_hint` |
| `display_hint` | `t***@example.com`, `861****1234` | the only identifier shape that leaves the server |
| `password_hash` | `scrypt$32768$8$3$<salt>$<key>` | never the password; verification is `timingSafeEqual` |
| `status` | `active` \| `disabled` | a disabled account fails every request immediately |
| `verified_at` | always `NULL` in this version | ownership was never verified; no copy claims otherwise |
| `created_at` | Unix ms | |

Not collected: real name, school, role (teacher vs student), date of birth, avatar.

### `session` — who is signed in

`id`, `account_id`, `token_hash` (`sha256` of the cookie value), `created_at`,
`last_seen_at` (written at most hourly), `expires_at` (60 days absolute), `revoked_at`
(sign-out or revocation). The raw session token exists only in the `HttpOnly` cookie; a
database leak does not yield a usable session token.

### `favorite` and `recent_use` — the user's own library

`favorite(account_id, experiment_id, created_at)`,
`recent_use(account_id, experiment_id, last_opened_at)`.
`recent_use` is de-duplicated per resource and stores **no parameter values, no counts and
no per-drag history**. Both tables are scoped by the account id derived from the session;
no request can name another account.

### `event` — diagnostics, best effort

One row per accepted event: `account_id`, `experiment_id`, `content_version`,
`app_version`, `locale`, `event_type` (7-value enum), `control_group` (enum),
`interaction_bucket` (enum), `error_code` (enum), `issue_category` (enum),
`device_class` (coarse: desktop/mobile/tablet/unknown), `visit_id` (client-generated random
id), `client_event_id`, `dedupe_key` (server-generated), `occurred_at_min`
(server clock, floored to the minute), `received_at` (internal, not exported).

Never stored here: user agent string, IP address, free text, slider or parameter values,
page URLs or query strings, screen recording, keystrokes. Unknown fields on an event are
ignored at write time; an event with an unsupported enum value is dropped and counted.

### `feedback` — what the user chose to say

`id`, `account_id`, `experiment_id`, `content_version`, `app_version`, `category` (5-value
enum), `message` (free text, control characters stripped, truncated to 2000 characters),
`created_at`. The UI shows the exact payload before sending and asks people not to type
personal data. A feedback submission also writes one category-only `feedback_submitted`
event (no text, no back-reference to the feedback id).

### `internal_audit` — who looked at whom

`operator_label`, `action` (`account_timeline` | `export_events` | `export_feedback`),
`target_type`, `target_id` (account id or window), `reason`, `row_count`, `created_at`.
It records the access, not the content: what an operator read is never copied here.

### `saved_state` — written only when the user presses save (B7)

One row per (account, experiment): `content_version`, `state_schema_version`, a canonical
JSON `payload` of the experiment's own whitelisted parameters (≤4096 bytes), `updated_at`.
Rows appear **only** after an explicit "save my settings" click — dragging a slider writes
nothing (asserted in `tests/e2e/saved-state.spec.ts` and `tests/host-saved-state.test.tsx`).
The parameters never leave the personal-data side: they are not in `event`, not in
`feedback`, not in any CSV export, and no diagnostic query can reach them. Deleting the
snapshot is self-service (the "delete saved settings" button on the experiment page), and
`ON DELETE CASCADE` from `account` already covers it when account deletion exists. There is
no per-snapshot history and no retention window of its own: a snapshot lives until the user
deletes it or the account goes away.

## 2. Who can read what

| Data | The account itself | Operator (token holders) | Anyone else |
|---|---|---|---|
| Masked identifier | yes | via per-account timeline / exports | no |
| Full identifier | no (only the masked hint) | no API path returns it | no |
| Own favorites / recent use / saved parameters | yes | no (not part of the operator channel) | no |
| Own events | no | aggregates; single account only with `reason` + label, audited | no |
| Own feedback | no list view | CSV export, audited | no |
| Other accounts' anything | no (structurally: every SQL is scoped by session account) | per-account, audited | no |

The operator channel is a Bearer token from the environment, not an account: it cannot be
granted to a normal user, and when it is unset those routes are not mounted at all.

## 3. What is deliberately absent

- No third-party analytics, fonts, CDNs or embeds: the SPA makes same-origin requests only
  (asserted in `tests/e2e/app.spec.ts`).
- No IP addresses in the database. Rate limiting counts in memory and forgets on restart.
- No cookies other than the session cookie; no `localStorage` of parameter values.
- No advertising or cross-site identifiers, no fingerprinting.
- No student records, grades, class rosters, or teacher/student role distinction.

## 4. Retention and deletion

| Data | Retention | Mechanism |
|---|---|---|
| `event` | 90 days | `scripts/retention-purge.mjs` (CLI, dry-run by default) |
| `feedback` | 180 days | same |
| `internal_audit` | 365 days | same |
| ended `session` rows | 30 days after revoke/expiry | same |
| `account`, `favorite`, `recent_use`, `saved_state` | until the user deletes it, or account deletion exists | the snapshot has its own delete button; everything else waits for account deletion |

There is **no self-service account deletion** and no data export for the individual yet
(design Q4). That is a blocker for public launch, not for local verification. When it is
built, `ON DELETE CASCADE` from `account` already removes sessions, favorites, recent use,
events, feedback and saved state; the audit trail intentionally has no foreign key, so the
record of who accessed data survives the account.

Diagnostic events are not used to reconstruct "recent use" and vice versa; the two are kept
apart on purpose (`docs/architecture/A-stage-design.md` §6.3).

## 5. Statements the product must not make

- "Verified email/phone" — nothing verifies ownership.
- "Anonymous usage statistics" — events are account-linked by design.
- "We never store your email" — the full identifier is stored to allow sign-in; only the
  displayed form is masked.
- "Data is deleted on request" — there is no deletion flow yet.

The in-app privacy text (`about.privacyBody` in both locales) is aligned with this map as of
B7 (`saved_state` is mentioned as "one set of parameters per experiment, only when you press
save"); if a table or a field changes, this file and that copy change together.
