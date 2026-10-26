# Operations runbook (local and first deployment)

Scope: how to start, watch, back up, restore, purge and stop OpenEduLab on a single host
running the built artifact. Everything here was executed on the development machine
(Windows 10, Node 22.23.0, SQLite through `node:sqlite`) — the commands are the same on a
Linux host with the paths adjusted.

This document does **not** authorise a production deployment. Server details, DNS, TLS and
retention policy still need the owner's approval (`docs/PROJECT_STATE.md` → 阻塞与未决).

## 1. Configuration

Every `OEL_*` variable is validated at startup; a missing required value exits with code 1
and lists **all** problems at once. An unknown `OEL_*` name is also an error (it catches
typos that would silently disable a setting).

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OEL_ENV` | yes | — | `development` \| `test` \| `production`. `production` switches the session cookie to `__Host-` + `Secure` and stops allowing `localhost` origins. |
| `OEL_PORT` | yes | — | 1–65535 |
| `OEL_HOST` | no | `127.0.0.1` | Bind address |
| `OEL_PUBLIC_ORIGIN` | yes | — | Origin only (`https://example.org`), no path/query/credentials. Drives the CSRF allow-list. |
| `OEL_DATABASE_PATH` | yes | — | File path. `:memory:` is refused in production. |
| `OEL_STATIC_DIR` | yes | — | Must contain `index.html` (run `npm run build`) |
| `OEL_MIGRATIONS_DIR` | yes | — | Must contain `NNNN_name.sql` |
| `OEL_CONTENT_DIR` | yes | — | Must contain `<folder>/manifest.json` |
| `OEL_OPERATOR_TOKEN` | no | unset | ≥16 chars. Unset ⇒ `/api/internal/*` is **not mounted** (404). |
| `OEL_EVENTS_ENABLED` | no | `true` | `false` ⇒ events are accepted and dropped (202), never an error to the user |
| `OEL_LOG_LEVEL` | no | `info` | `silent` turns the logger off |

Startup order is fail-closed: content index → migrations → routes → listen. Any of the
first two failing means the process exits instead of serving a partial app.

## 2. Start and stop

```bash
cd G:/hermes/projects/openedulab
npm run build && npm run build:api

OEL_ENV=development OEL_HOST=127.0.0.1 OEL_PORT=3220 \
OEL_PUBLIC_ORIGIN=http://127.0.0.1:3220 \
OEL_DATABASE_PATH=apps/api/data/local.sqlite \
OEL_STATIC_DIR=dist OEL_MIGRATIONS_DIR=apps/api/migrations \
OEL_CONTENT_DIR=experiments OEL_LOG_LEVEL=info \
node apps/api/dist/index.js
```

Health check (never leaks paths, configuration or secrets):

```bash
curl -s http://127.0.0.1:3220/api/healthz
# {"status":"ok","appVersion":"0.1.0-m1",...,"database":{"ok":true,
#  "migrations":{"applied":1,"latest":"0001","pending":0}}}
```

`503 degraded` means a migration file appeared after startup; `503 error` means the schema
state cannot be read. Both are "do not send users here yet".

### Stopping exactly one instance

Identify first — never kill every `node` process, the machine runs other agents:

```bash
netstat -ano | grep ':3220 '            # -> last column is the PID
wmic process where "ProcessId=<PID>" get CommandLine,ExecutablePath
# expect: node.exe ... apps/api/dist/index.js
taskkill /PID <PID> /F
```

`npm run test:e2e` needs port 3220 free and refuses to reuse an existing server; if a
hand-off instance is running, stop that PID as above before running the suite.

## 3. Logs

Fastify logs to stdout (JSON when `OEL_LOG_LEVEL` is not `silent`). Cookies and
`authorization` headers are redacted by the logger configuration. There is no log file
writer in the app: under a service manager, redirect stdout to the manager's log.

## 4. Operator channel (`/api/internal/*`)

Only when `OEL_OPERATOR_TOKEN` is set. Access is the token, not an account: a normal
session gets the same 404 an unknown path gets, and the routes are not mounted at all when
the token is unset.

- Send the token with the standard authorization header, Bearer scheme, e.g. with curl:
  `curl --oauth2-bearer "$OEL_OPERATOR_TOKEN" ...`
- `X-Operator-Label` (your identifier) is required wherever an account can be identified.
- `reason` (≥8 characters) is required for a single-account timeline and for every export.
- Every such read and every export writes a row to `internal_audit`
  (label, action, target, reason, row count — never the content read).

Examples:

```bash
W="from=$(($(date +%s)000 - 604800000))&to=$(($(date +%s)000))"
curl -s --oauth2-bearer "$OEL_OPERATOR_TOKEN" "http://127.0.0.1:3220/api/internal/overview?$W"

curl -s --oauth2-bearer "$OEL_OPERATOR_TOKEN" \
  -H "x-operator-label: owner-laptop" \
  "http://127.0.0.1:3220/api/internal/export/events.csv?$W&reason=weekly%20content%20review" \
  -o events.csv
```

Failure budgets: 60 operator requests per minute per process; 10 wrong tokens per minute per
peer address. Rate-limiter state is in-process — a restart clears it, and multiple instances
do not share it (accepted single-instance assumption, design §4.5 / risk R6).

`dataGaps` is how the channel says "unknown": when `OEL_EVENTS_ENABLED=false` the window is
reported as `events_disabled` rather than as zero usage. Windows in which ingestion failed
mid-way are **not** detected yet (only the disabled case is implemented).

## 5. Backup

Local SQLite, `VACUUM INTO` (consistent while WAL writers are active):

```bash
mkdir -p backups
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('apps/api/data/local.sqlite');d.exec(\"VACUUM INTO 'backups/oel-'+new Date().toISOString().slice(0,16).replace(/[:T]/g,'')+'.sqlite'\");d.close()"
```

or, with the built-in checker (which also verifies the snapshot it just took):

```bash
npm run check:backup -- --db apps/api/data/local.sqlite --out docs/evidence/b8/backup.json
```

Target: daily + before every migration/release; keep 14 days + 4 weeks. **A snapshot on the
same disk is not a backup** — copying it to another machine or object storage is required
for a real deployment. That cross-machine step is a server decision and has *not* been done
or verified here (no server access exists yet).

RPO ≤ 24 h, RTO ≤ 1 h for a single-instance teaching site. Anything tighter needs WAL
archiving or streaming replication, which is a new decision.

## 6. Restore drill (run it, do not assume it)

```bash
npm run check:restore -- --db apps/api/data/local.sqlite --out docs/evidence/b8/restore.json
```

What it does, and what a PASS therefore means:

1. takes (or accepts via `--backup <file>`) a snapshot;
2. copies it into a fresh temporary directory — a real restore is a copy, not opening the
   original;
3. `PRAGMA integrity_check`, table counts, migration baseline, canary write/read/delete on
   the copy;
4. boots the **real built API** against the restored file on port 3321, requires
   `/api/healthz` = `ok` with at least one applied migration, then proves the restored
   database accepts a write by registering a throwaway account over HTTP.

Run it monthly and before every release. An untested backup counts as no backup.

Manual restore on a real host (only during an approved maintenance window):

```bash
systemctl stop openedulab            # or the equivalent for your supervisor
cp apps/api/data/local.sqlite apps/api/data/local.sqlite.pre-restore
cp backups/oel-YYYYMMDDTHHMM.sqlite apps/api/data/local.sqlite
rm -f apps/api/data/local.sqlite-wal apps/api/data/local.sqlite-shm
systemctl start openedulab
curl -s localhost:3220/api/healthz
```

Migrations only move forward and must stay compatible with one previous version, so
restoring an older **code** build does not require restoring the database (see
`docs/ops/rollback.md`).

## 7. Retention purge

Design §9.4: events > 90 days, feedback > 180 days, operator audit > 365 days, ended
sessions (revoked or expired) > 30 days. There is **no HTTP endpoint** for this — deletion
is a file-level maintenance action.

```bash
npm run build:api                       # the CLI runs the compiled rules the tests cover
npm run retention:dry-run -- --db apps/api/data/local.sqlite
npm run retention:purge -- --db apps/api/data/local.sqlite \
  --confirm-database apps/api/data/local.sqlite
```

Guards (each one is a test in `apps/api/test/retention.test.ts`):

- dry run is the default and changes nothing;
- `--apply` refuses to run unless `--confirm-database` resolves to the same file as `--db`,
  so a mistyped path cannot delete the wrong dataset;
- `:memory:` is refused;
- deletion happens in one transaction and re-running is a no-op for rows already gone.

Accepted loss: there is no daily rollup, so purged events cannot be re-aggregated later.

## 8. Periodic checklist (single instance)

| Cadence | Action |
|---|---|
| Daily | snapshot + `check:backup`; look at `/api/healthz` |
| Weekly | read `internal_audit` for unexpected operator reads; check 429 rates |
| Monthly | `check:restore` drill; rotate `OEL_OPERATOR_TOKEN`; review disk space |
| Per release | `npm run ci:local`; snapshot before deploying; keep the previous build directory |
| Quarterly | re-read `docs/privacy/data-map.md` against what the code actually stores |

## 9. First response

| Symptom | First checks |
|---|---|
| Process exits at startup | stderr lists every config problem; then content index issues (`manifest.json`, locales), then migration checksum mismatch |
| `/api/healthz` 503 `degraded` | a migration file appeared after start — restart during a window, do not edit applied files |
| Users see 401 everywhere | cookie name matches `OEL_ENV` (`__Host-oel_sid` in production needs HTTPS), `OEL_PUBLIC_ORIGIN` must equal the browser origin |
| All writes 403 | CSRF: the page must be served from the configured origin; writes must be `application/json` with an `Origin` header |
| Operator channel 404 | `OEL_OPERATOR_TOKEN` unset or wrong; after 10 wrong tokens per minute a peer gets 429 |
| SPA shell loads but data does not | `/api/*` is answered by the API, not the shell — check the API process and the session, not the bundle |
