# Rollback

Two things can be rolled back: the **code** (build artifact) and the **database** (schema and
data). They have different rules, and mixing them up is how a rollback becomes an outage.

## 1. Code rollback (the normal case)

Migrations are forward-only and must stay compatible with one previous version (design §9.1),
so a code rollback normally does **not** touch the database.

```bash
# keep the previous build next to the current one on every release
cp -r dist dist.previous
cp -r apps/api/dist apps/api/dist.previous
```

To roll back:

1. Announce the window; stop the process by PID (`netstat -ano | grep ':3220 '` then
   `taskkill /PID <pid> /F`, or the service manager's stop).
2. Swap the directories back:
   `mv dist dist.broken && mv dist.previous dist`, same for `apps/api/dist`.
3. Start the previous build with the **same** environment and database path.
4. Verify: `curl -s localhost:3220/api/healthz` → `status: ok`, then sign in and open the
   experiment. A 503 `degraded` here means the database has migrations the old code does not
   know about — stop and go to §2.
5. Keep the broken build for diagnosis; do not delete the log of the failed release.

## 2. Database rollback (only when the schema itself is the problem)

Only possible from a snapshot taken **before** the migration ran. If no such snapshot exists,
the honest answer is "this cannot be rolled back" — restore from the last one that does and
accept the data loss window (RPO ≤ 24 h by design).

```bash
# during an approved window, with the service stopped
cp apps/api/data/local.sqlite apps/api/data/local.sqlite.failed-$(date +%Y%m%dT%H%M)
cp backups/oel-YYYYMMDDTHHMM.sqlite apps/api/data/local.sqlite
rm -f apps/api/data/local.sqlite-wal apps/api/data/local.sqlite-shm
# restart previous code, then:
node scripts/restore-check.mjs --db apps/api/data/local.sqlite --out /tmp/restore.json
```

Never edit an applied migration file to "undo" it: the runner refuses to start on a checksum
mismatch, by design. Undo means a new forward migration.

## 3. Configuration rollback

Environment variables are the whole configuration; keep the last known-good set in the
deployment system, not in the repository. If the service fails to start after a config
change, the stderr listing tells you every invalid field at once — restore the previous value
set and restart. Do not "fix" it by adding a default.

## 4. Content rollback

Content is data (`experiments/<folder>/manifest.json` + locales) read at startup. A bad
manifest fails the whole startup (the index is validated as a unit), so rolling content back is:

1. restore the previous `manifest.json`/`locales/*.json`;
2. restart the process (the index is loaded once);
3. confirm `/api/catalog` shows the expected `contentVersion`.

Removing an experiment from the manifest removes it from the catalog; historical events and
saved rows for it are left alone (design Q8).

## 5. What rollback must never do

- Edit `schema_migrations` by hand to make a checksum error go away.
- Delete `-wal`/`-shm` files while a process is running.
- Restore a database from an **untested** snapshot: run `check:restore` first, on a copy.
- Roll back by editing tests or removing assertions.

## 6. Evidence to record for each release

`git rev-parse HEAD`, the `appVersion` reported by `/api/healthz`, the snapshot path used,
the `restore.json` report, and the operator label of whoever performed the change.
