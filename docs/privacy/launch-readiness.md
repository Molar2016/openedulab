# Launch readiness: open sign-up, deletion & export, minors

This is the R3 risk note. It records what the code can and cannot do today, what an abuser
could do with it, and which decisions belong to the project owner. It is not legal advice and
it does not change any behaviour: nothing here was implemented, and no policy was invented.

Facts below are taken from the code, with the test that pins each one.

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

## 2. Account deletion and personal-data export

### What exists

- `ON DELETE CASCADE` from `account` covers `session`, `favorite`, `recent_use`,
  `saved_state`, `event`, `feedback` (`apps/api/migrations/0001_init.sql`).
- `internal_audit` deliberately has **no** foreign key: the record of "an operator read
  account X for reason Y" survives deletion. It stores the operator label, the action, the
  target id, the reason and a row count — never the content read.
- There is **no** self-service deletion and **no** export. `docs/privacy/data-map.md` lists
  this as a blocker, and the product must not claim "data is deleted on request".

### Why it blocks a public launch

- PIPL (China) art. 45/47 give the individual a right to copy and to delete; GDPR art. 15/17/20
  apply if EU residents are in scope. "We have no deletion flow yet" is not a lawful answer
  once real people sign up.
- The data is small but personal: identifier, password hash, favourites, recent opens, saved
  parameters, events, feedback text.

### What implementing it would take (scope estimate, not a commitment)

- `DELETE /api/me` — session-gated, requires the current password again, one transaction,
  returns 204; tests must prove the cascade removed every table row and that the session
  cookie is dead afterwards, and that `internal_audit` rows survive with a dangling target id.
- `GET /api/me/export` — JSON download of account (masked identifier + timestamps),
  favourites, recent use, saved parameters, feedback the user wrote, and event *counts*
  (not the operator's analytic view). Same gate, `Content-Disposition: attachment`, and a
  test that the payload contains no other account's data and no operator-only fields.
- Both belong to the same "personal data" family as `saved_state` and should follow the same
  pattern: route inventory entry, CSRF, rate limit, cross-account tests.

Recommendation: implement both **before** any sign-up that a non-owner can reach; they are
hours of work against an established pattern, and their absence is the single clearest
compliance hole.

## 3. Minors

The product is aimed at classrooms, which includes middle- and high-school students.

- Under PIPL, personal information of children **under 14** is sensitive personal information:
  it needs guardian consent and dedicated processing rules. The trigger is the data subject's
  age, not which fields are collected — an email address of a 13-year-old is still covered.
- Today the system collects an identifier (email/phone) and a password hash, and nothing else
  that identifies a person. There is no age field, no real name, no school, no class, no
  roster.
- There is therefore no way for the service to know whether a user is a child, and no
  guardian-consent mechanism. The current copy makes no claim about children — which is
  correct, and must stay that way until a model is chosen.

Options (owner's decision):

1. **Institution-controlled use**: the school/teacher is the controller, accounts are created
   for a class, the platform is a processor. Requires a written agreement, not code.
2. **18+ / adult self-sign-up** with an age affirmation and no school-facing features.
3. **Guardian-consent flow** for under-14: an age gate, a consent record, a way to withdraw.
   This is the heaviest option and none of it exists.

Recommendation: pick (1) or (2) before any public launch; do not launch with open sign-up and
no age model, and do not describe the service as child-appropriate.

## 4. What was deliberately not done in R3

- No server, DNS, firewall or certificate action; no port scan; no `ssh`/`scp` to any host.
- No change to registration, verification, deletion or export behaviour — those are decisions
  above, and two of them (verification, minors model) carry cost or legal weight.
- No licence choice, no terms of service, no privacy policy text beyond the in-app summary.
- No claim that any of this is compliant. The point of the document is to name what is
  missing, with the code paths that show it.
