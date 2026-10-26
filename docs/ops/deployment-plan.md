# Test deployment plan (R3): what is missing, and what to do the moment it is supplied

Status: **BLOCKED**. No server, domain or access method for this project has been supplied,
and the read-only reconnaissance on the development machine found nothing that is
demonstrably this project's test environment. Nothing outside this machine was contacted.

Evidence for the search itself: `docs/evidence/r3/recon.txt` (captured 2026-10-27).

## 1. What the reconnaissance actually found

| Checked | Result | Why it does not count as a target |
|---|---|---|
| `git remote -v` in this repo | only `https://github.com/Molar2016/openedulab.git` | a source remote, not a deployment |
| `~/.ssh/config` | does not exist | no host aliases are configured on this machine |
| `~/.ssh/` entries | keys named `deliver_vps`, `id_ed25519`, `id_ed25519_classroom_vps` | names only. Nothing ties any of them to OpenEduLab, and the delivery-VPS path is explicitly out of scope for this project |
| `~/.ssh/known_hosts` | `[172.16.12.27]:30134`, `8.148.14.233`, one hashed entry | hosts some *other* workflow contacted. Not probed, not connected to, not assumed |
| repo contents | no `Dockerfile`, no compose file, no unit file, no deploy script; the only `systemctl` mentions are generic examples in `docs/ops/runbook.md` | there is no deployment artefact to reuse |
| local listeners on 3220 / 3321 / 3000 / 8080 / 80 / 443 | nothing listening | no local instance is running right now |
| container/supervisor tooling | `docker`, `podman`, `pm2`, `nginx`, `caddy`, `rsync` all absent; `ssh`/`scp` present | the plan below cannot assume a container runtime |

Deliberate non-actions: no `ssh`/`scp` attempt to any host found in `known_hosts`, no port
scan, no DNS query, no cost application, no account creation, no change to any existing
service. Guessing a target from key names or a stale `known_hosts` entry would be exactly the
"pretend it is deployed" failure this gate exists to prevent.

## 2. What the owner must supply (blocker text)

> 远端测试部署阻塞：需服务器地址/访问方式/独立域名等

Concretely, all five are needed before a test deployment can start:

1. **Host**: address, OS, CPU/RAM/disk, and whether it is dedicated to this project or shared.
2. **Access**: SSH user + key or an equivalent, and whether privilege escalation is allowed.
3. **Name**: a domain or subdomain for this instance (needed for `OEL_PUBLIC_ORIGIN`, the
   CSRF origin allow-list, and HTTPS cookies). A bare IP over plain HTTP cannot work in
   production mode — see §4.
4. **Database decision**: single-instance SQLite on the host (what is verified today) or
   PostgreSQL (design candidate, never exercised by this codebase).
5. **Data-protection decisions** — retention window still open; **minors and deletion/export
   were decided on 2026-10-27** (no age gate; deletion and export out of scope for v1) and are
   recorded in `docs/privacy/launch-readiness.md` §2–§3. What remains fact-finding rather than
   a code change is the service region and the actual personal-data inventory (§5 row 2–3
   there). A test instance that only the owner uses with invented accounts can proceed
   without them; anything reachable by other people cannot.

## 2.1 GitHub Pages: static hosting only — deliberately **not enabled**

The owner asked whether GitHub Pages could serve as the test site. It cannot serve *this*
application, and the honest answer is a scope statement rather than a workaround:

| What Pages provides | What this app needs |
|---|---|
| static files from a repository over HTTPS, no server-side code | a Fastify process: `/api/*` routes, server-side sessions in SQLite, CSRF origin checks, per-IP rate limiting |
| no `Set-Cookie` control, no request-time logic | `__Host-oel_sid` HttpOnly cookie issued by the server on login |
| no database, no writes | SQLite file on the host (`node:sqlite`), migrations, `VACUUM INTO` backups |
| a public URL for the whole world by default | a login gate whose every API response is scoped by the session's account id |

So on Pages the built SPA would load and then fail every request: the catalogue, the
experiment metadata, favourites, recent use, saved parameters and the operator channel all
come from `/api/*` behind `requireSession()`. There is no configuration of Pages that changes
that, because the missing piece is the server, not the routing.

**Decision (2026-10-27): Pages stays disabled.** Three reasons, in order:

1. An empty shell at a public URL is worse than no URL — a visitor cannot sign in, cannot see
   an experiment, and would reasonably conclude the product is broken (or, worse, that the
   repository is a finished public site).
2. Making it look complete would require a fake backend or invented data, which is exactly
   what the project's ground rules forbid (no fake endpoints, no fabricated results).
3. The only useful Pages artefact would be a small static introduction page ("what this is,
   what it is not, where the source lives"), and that is a separate, honestly-labelled
   decision — not a stand-in for the application, and not requested yet.

If a static introduction page is ever wanted, it must say plainly: no live demo, no public
instance, sign-in requires the server, and the repository is source only. It must not embed
the SPA build, mock the API, or link to a URL that does not exist yet.

The actual deployment path stays as described in §5, and remains blocked on the inputs in §2.

## 3. What is already proven locally (so deployment is configuration, not development)

- one process serves `/api/*` and the built SPA from the same origin (`scripts/e2e-server.mjs`
  proves the exact shape), so there is no CORS surface to configure;
- configuration is fail-closed: a missing or unknown `OEL_*` variable exits with code 1 and
  lists every problem at once (`apps/api/test/config.test.ts`);
- migrations are numbered, checksummed, single-transaction; tampering refuses to start;
- `scripts/backup-check.mjs` + `scripts/restore-check.mjs` prove snapshot, integrity, counts,
  and that a restored database can boot the API and accept a write;
- `scripts/retention-purge.mjs` is dry-run by default and requires the database path twice to
  delete anything;
- GitHub Actions runs the whole suite on `main` on every push (run history:
  `docs/evidence/r1/remote-ci.txt`, `docs/evidence/b7/check-b7.txt`).

## 4. Constraints that must shape the plan (learned from the code, not guessed)

1. **HTTPS is mandatory in production, not optional.** `OEL_ENV=production` switches the
   session cookie to `__Host-oel_sid` with `Secure`, so a plain-HTTP origin cannot hold a
   session at all. TLS termination in front of the process is required.
2. **`trustProxy=false`** is deliberate. Behind a reverse proxy every request appears to come
   from the proxy, which collapses the per-IP rate limits into one bucket. Two honest options:
   terminate TLS on the same host and bind the proxy to loopback (accepted, documented), or
   add explicit proxy-trust configuration first (a code change with its own tests). Do not
   silently flip the flag.
3. **Single instance only.** Rate limiting and lockouts live in process memory; sessions live
   in SQLite. Two instances behind a load balancer would give users two different limiter
   budgets and two writers to one SQLite file. Design Q6/D14 already records this.
4. **SQLite is a file on that host.** Backups must be `VACUUM INTO` snapshots copied *off* the
   host; the drill that proves a restore must run on the target at least once, not just here.
5. **No email/SMS is configured**, so nothing may promise password reset or verification. Any
   "forgot password" link would be a lie today.

## 5. The plan, ready to execute once a target exists

Isolation rules: its own OS user, its own directory, its own database file, its own origin,
its own service unit. Never share a reverse-proxy root, a database file or a session cookie
domain with any existing site on that host.

```
/opt/openedulab/
  app/           # built artifact: dist/ (SPA) + apps/api/dist/ + apps/api/migrations/ + experiments/
  data/app.sqlite# OEL_DATABASE_PATH (0600, owner = service user)
  env/openedulab.env  # 0600, the OEL_* values; never in git
/var/backups/openedulab/   # VACUUM INTO snapshots, copied off-host daily
```

Steps (each with the check that proves it):

1. Create the service user; deploy the artifact by `git archive` of a tagged commit, not by
   copying a working tree. Prove: `git status` clean at the deployed commit.
2. Write `openedulab.env`:
   `OEL_ENV=production`, `OEL_HOST=127.0.0.1`, `OEL_PORT=3220`,
   `OEL_PUBLIC_ORIGIN=https://<host>`, `OEL_DATABASE_PATH=/opt/openedulab/data/app.sqlite`,
   `OEL_STATIC_DIR=/opt/openedulab/app/dist`,
   `OEL_MIGRATIONS_DIR=/opt/openedulab/app/apps/api/migrations`,
   `OEL_CONTENT_DIR=/opt/openedulab/app/experiments`, `OEL_LOG_LEVEL=info`,
   `OEL_EVENTS_ENABLED=true|false`, `OEL_OPERATOR_TOKEN=<32+ random bytes>`.
   Prove: starting with one variable removed exits 1 and names the variable.
3. systemd unit `openedulab.service` (Restart=on-failure, `EnvironmentFile=`), listening on
   loopback only. Prove: `systemctl status` active, `curl 127.0.0.1:3220/api/healthz` → `ok`.
4. Reverse proxy with a real certificate, forwarding to `127.0.0.1:3220`, preserving `Host`.
   Prove: `curl -I https://<host>/` → 302 to `/login` and a `Set-Cookie: __Host-oel_sid=…;
   Secure; HttpOnly; SameSite=Lax` on login over HTTPS.
5. Smoke against the deployed process: run `apps/api/scripts/smoke.mjs` with `OEL_*` pointed
   at a *scratch* database on the host (never the live one). Prove: `# N/N checks passed`.
6. Backups: nightly `VACUUM INTO`, copy off-host, keep 14 daily + 4 weekly; monthly restore
   drill on the host. Prove: one real restore, `healthz` ok, one test account can register.
7. Retention: nightly `retention-purge.mjs --dry-run` logged; weekly `--apply
   --confirm-database <same path>` once the owner has picked the retention window.
8. Monitoring: poll `/api/healthz` every minute; alert on non-200 or `migrations.pending > 0`;
   watch disk for the SQLite file and the backup directory.
9. Rollback: keep the previous artifact directory; `systemctl stop`, swap symlink, `start`.
   Migrations are forward-only, so a rollback that crosses a migration needs the matching
   snapshot restored — decide this before the first schema change, not after.
10. Announcement rule: nothing is announced as "online" until steps 4, 5, 7 and 8 have run on
    the target and their outputs are stored in `docs/evidence/`.

## 6. Pre-flight checklist (all must be answerable with a command output, not an opinion)

| # | Question | How it is answered |
|---|---|---|
| 1 | Is the host dedicated to this project? | host owner's written confirmation |
| 2 | Is there a domain pointing at it, and does HTTPS validate? | `curl -I https://<host>/` |
| 3 | Does the deployed commit equal a commit that passed CI? | `git rev-parse HEAD` vs the run list |
| 4 | Are all `OEL_*` values present and is the DB path writable by the service user only? | startup log, `ls -l` |
| 5 | Does `healthz` report `migrations.pending: 0`? | `curl …/api/healthz` |
| 6 | Does a real browser sign-in work over HTTPS with the `__Host-` cookie? | one Playwright run against the target |
| 7 | Is the operator token ≥16 chars, random, and not in git? | `git grep` for the value (must be empty) |
| 8 | Does a backup exist off-host and has a restore been drilled there? | restore report from the target |
| 9 | Is retention scheduled, with the window decided? | cron/systemd timer + dry-run log |
| 10 | Is there a monitoring alert on healthz? | alert config + one fired test |
| 11 | Is the previous artifact kept for rollback? | `ls` + tested swap |
| 12 | Are the deletion/export, minors and region decisions recorded? | `docs/privacy/launch-readiness.md` §2, §3, §5 |
| 13 | Does anything claim a public URL that does not resolve yet? | `git grep` the URL in docs |
| 14 | Is a licence committed (MIT or Apache-2.0, owner's choice)? | `ls LICENSE`, `docs/third-party.md` |

## 7. What this document is not

It is not an approval, not a schedule and not a claim that a deployment exists. Until the five
inputs in §2 arrive and the checklist in §6 is answered with real output, the project state
stays: **no deployment, no domain, no public URL**.
