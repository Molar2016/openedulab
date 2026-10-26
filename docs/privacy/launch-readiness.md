# Launch readiness: open sign-up, deletion & export, minors

This is the R3 risk note. It records what the code can and cannot do today, what an abuser
could do with it, and which decisions belong to the project owner. It is not legal advice and
it does not change any behaviour: nothing here was implemented, and no policy was invented.

Facts below are taken from the code, with the test that pins each one.

**Status 2026-10-27 (R5)**: §2 and §3 were rewritten after the project owner's decisions —
account deletion and personal-data export are **out of scope for the first release**, and
there is **no minors age gate** (with a factual pre-launch check kept). §1 (open sign-up) is
unchanged and still owner-pending. §5 is the gate that remains before anything is publicly
reachable.

## 1. Open self-registration without ownership verification

### What the system actually does

- `login_kind` is `email` or `phone`; the identifier is normalised (trim, lower-case, phone
  separators stripped) and unique per namespace (`apps/api/test/auth.register.test.ts`).
- `verified_at` stays `NULL` for every account. Nothing verifies that the registrant controls
  the address or number, and no screen claims otherwise (`tests/i18n.test.ts`, and the design
  rule in `docs/privacy/data-map.md` §5).
- There is **no password reset** and no rebinding flow. Verification would therefore not be a
  "recovery" feature today — it would only be an anti-squatting measure.
- Rate limits: 5 registrations/hour/IP and 3/day/identifier; logins 30/15min/IP,
  10/15min/identifier+IP, 10 consecutive failures lock for 15 minutes
  (`apps/api/src/http/auth-routes.ts`, `apps/api/test/rate-limit.test.ts`). The limiter is
  in-process: a restart clears it, and it assumes one instance (design D14/Q6).
- The displayed identifier is always masked (`t***@example.com`, `861****1234`); the API never
  returns the full value.

### What an attacker can do, and what they cannot

| Scenario | Reality today | Who it hurts |
|---|---|---|
| Register someone else's email/phone ("squatting") | allowed, silently. The real owner then cannot register that identifier (409 `identifier_taken`) | the person whose address was used, and the platform's credibility |
| Take over an existing account via that address | **not possible**: no reset, no verification, no email sending. Sign-in requires the password | — |
| Read another account's data | **not possible**: every SQL statement is scoped by the session's `account_id`; cross-account cases are tested (`saved-state.test.ts`, `isolation.spec.ts`) | — |
| Discover whether an identifier is registered | possible via registration (409 vs 201). Login responses are byte-identical for wrong password and unknown identifier, so login is not an oracle | minor privacy leak (enumeration) |
| Automated account creation | bounded per IP (5/hour) but **not** globally: each new account gets a fresh event budget | database growth, operator noise |
| Spam diagnostics | 120 events/min and 3000/day per account; each new account resets that | storage growth, skewed aggregates |
| Abuse through feedback | 5 submissions/hour/account, text capped at 2000 chars, control characters stripped | operator attention |

Quantified worst case for one IP with no verification and no captcha: 5 accounts/hour →
120 accounts/day → up to 360 000 accepted events/day, roughly 30–60 MB/day of rows before
retention (90 days) kicks in. That is a bounded but real resource-exhaustion path on a small
host.

### Mitigations that exist now

- rate limits above, plus 429 with `Retry-After`;
- operator channel can locate a single account (`/api/internal/accounts/:id/timeline`) and the
  audit table records who looked;
- an account can be disabled at the database level (`account.status = 'disabled'`) and every
  request from it fails immediately — there is no HTTP endpoint for this, which is a
  deliberate gap for later, not an oversight;
- retention CLI limits how long junk lives.

### Decisions the owner has to make before public sign-up

1. Is sign-up open to anyone, or gated (invite code, teacher approval, school domain list)?
2. Is any ownership verification added (email link / SMS)? Both imply a third party, a cost
   and a new failure mode; SMS in particular adds a real-name-adjacent data trail.
3. Is a captcha / proof-of-work needed to stop bulk registration? Without it the 5/hour/IP
   limit is the only brake.
4. Is identifier enumeration acceptable (409 on registration)? If not, registration must stop
   telling the caller that the identifier exists — that is a UX/abuse trade-off, not a bug.

Until at least one of (2) or (3) is in place, opening registration to the public internet
means accepting account squatting and scripted sign-ups. That is a product decision, not
something this task may decide.

## 2. Account deletion and personal-data export — **out of scope for v1** (owner decision, 2026-10-27)

### The decision, and what it does *not* mean

The project owner decided on 2026-10-27 that the first release ships **without** account
deletion and **without** personal-data export. This is a scope decision, recorded here and in
`docs/requirements-v2.1.md` §6. It replaces the earlier "hard blocker" framing, and it does
**not** mean the gap is invisible:

- The product must never claim a self-service delete or export it does not have. The list of
  forbidden statements is `docs/privacy/data-map.md` §5 ("Data is deleted on request" is on
  it), and the in-app privacy text says what *is* stored, not what can be erased.
- Someone who wants out has exactly one real route today: the operator disables the account
  at the database level (`account.status = 'disabled'`, no HTTP endpoint). That is a
  maintenance act by the maintainer, not a user right, and no screen may present it as one.
- The residual risk this accepts — an individual has no self-service way to obtain or erase
  their own data — is named here as an accepted, owner-acknowledged risk of the first
  release, not as compliance.

### What is true in the code

- `ON DELETE CASCADE` from `account` covers `session`, `favorite`, `recent_use`,
  `saved_state`, `event`, `feedback` (`apps/api/migrations/0001_init.sql`).
- `internal_audit` deliberately has **no** foreign key: the record of "an operator read
  account X for reason Y" survives account deletion. It stores the operator label, the action,
  the target id, the reason and a row count — never the content read.
- There is **no** `DELETE /api/me` and **no** `GET /api/me/export`; no test pretends
  otherwise, and no route inventory entry exists for them.
- The cascade is therefore currently unreachable: nothing deletes an `account` row. If that
  ever changes (an admin CLI, or a later release implementing deletion), the cascade is what
  makes one transaction enough — which is why the schema was designed this way from B1.

### If it is ever pulled back into scope (sketch, not a commitment)

- `DELETE /api/me` — session-gated, requires the current password again, one transaction,
  204; tests must prove the cascade removed every table row, that the session cookie is dead
  afterwards, and that `internal_audit` rows survive with a dangling target id.
- `GET /api/me/export` — JSON download of account (masked identifier + timestamps),
  favourites, recent use, saved parameters, the user's own feedback, and event *counts* (not
  the operator's analytic view). Same gate, `Content-Disposition: attachment`, plus a test
  that the payload contains no other account's data and no operator-only fields.
- Both belong to the same "personal data" family as `saved_state` and should follow the same
  pattern: route inventory entry, CSRF, rate limit, cross-account tests.

## 3. Minors — no age gate, and no assumption that children's data is out of scope

Decision (owner, 2026-10-27): the product does **not** impose a "minors not allowed" age gate.
It is a teaching tool; classrooms contain minors, and a gate that pushes them out would defeat
the purpose. What follows from that decision, stated carefully:

- **Not** "therefore no children's personal data is processed". Whether the service processes
  a child's personal data depends on who actually signs up and where the service is offered,
  not on our intention. An identifier plus a password hash of a 13-year-old is still personal
  information about a child.
- **No invented legal threshold.** This document does not declare a statutory age, does not
  claim a jurisdiction applies, and does not claim compliance with any of them. The earlier
  draft's "under 14 ⇒ sensitive personal information" was a specific legal regime applied to
  a service region nobody has chosen yet; it is demoted here to "a question to answer with
  facts", not a rule this repo enforces.
- **What is kept: a minimal, factual compliance check before public launch** — two questions,
  both answerable with documents rather than code:
  1. **Where will the service actually be offered?** (region of the operator, of the hosting
     provider, and of the intended users). No region has been chosen, so no regime is
     asserted.
  2. **What personal data does the service actually touch?** From the code: a normalised
     email or phone, a scrypt password hash, favourites, coarse recent-use rows, explicitly
     saved parameters, whitelisted diagnostic events, and free-text feedback. No real name,
     no age, no school, no class, no roster, no grades, no IP addresses
     (`docs/privacy/data-map.md`). That is the honest inventory a review would start from.
- **No hard block in code.** Nothing in the app asks for an age, infers one, or terminates an
  account because of one. Adding such a mechanism is not part of v1.
- **Copy stays honest.** The in-app text makes no claim about children, about appropriateness
  for a given age, or about consent. That must remain true: do not describe the service as
  child-appropriate, and do not describe it as adults-only either.
- **Accountability stays with the owner**: if the service is later offered in a region whose
  rules require guardian consent or a dedicated children's-data process, that is a decision
  and a code change for that moment — the launch-readiness gate below exists so it is asked
  before launch, not after.

## 4. What was deliberately not done in R3, and what R5 changed

R3 did none of the following: no server, DNS, firewall or certificate action; no port scan;
no `ssh`/`scp` to any host; no change to registration, verification, deletion or export
behaviour; no licence choice, no terms of service, no privacy policy text beyond the in-app
summary; and no claim that any of this is compliant.

R5 (2026-10-27) changed **decisions and documentation only**: deletion/export moved from
"blocker" to "out of scope for v1" by owner decision (§2), the minors model moved from
"pick one of three" to "no age gate, keep a factual pre-launch check" (§3), and the licence
question is still open, awaiting MIT vs Apache-2.0. No code, no migration and no route
changed as part of this. The pre-launch gate that remains is in §5.

## 5. The gate that remains before anything is publicly reachable

Nothing in this document authorises a launch. "The owner agreed to keep working on
pre-release items" is not "the owner approved putting a site on the public internet". Before
any deployment, the owner must give explicit, separate approval, and these must be answered
with facts:

| # | Question | Where the answer comes from |
|---|---|---|
| 1 | Explicit owner approval for this deployment (host, DNS, credentials, public reachability) | owner, in writing, per deployment |
| 2 | Which region will the service be offered in, and to whom? | owner; feeds §3 |
| 3 | What personal data does the service actually process? | `docs/privacy/data-map.md` (code-derived inventory) |
| 4 | Is sign-up open to anyone, and is that acceptable without ownership verification? | §1 decisions 1–4 |
| 5 | Does any screen, doc or store listing claim deletion/export/verification that does not exist? | `git grep` before release; `docs/privacy/data-map.md` §5 |
| 6 | Are retention windows and the operator token settled for that host? | `docs/ops/runbook.md`, `docs/ops/deployment-plan.md` §6 |
| 7 | Licence chosen (MIT or Apache-2.0) and `LICENSE` committed? | `docs/third-party.md` — still open |

Rows 2 and 5 are the ones this round changed the framing of; rows 1, 6 and 7 stay exactly as
demanding as before.
