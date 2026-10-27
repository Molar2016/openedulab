# Publishing the test instance under a bare IP with HTTPS — assessment (R6)

Status: **assessed, not executed.** The server-internal test instance from R6 §A is running and
verified; nothing in this document has been applied. Every step that would touch the shared web
server, the host resolver or public exposure needs the owner's decision, because all three change
something other people depend on.

Evidence: `docs/evidence/r6/https-probes.txt`, `docs/evidence/r6/port443.txt`,
`docs/evidence/r6/server-facts.txt`. The host address is deliberately not written in this public
repository; it is the owner's existing classroom-game VPS.

## 1. What the measurements actually say

Four assumptions had to be checked before any plan could be written. Two of them turned out to be
wrong, and both errors were in the *optimistic* direction, so the plan below is built on measurements
rather than on the brief.

| # | Assumption in the brief | Measured | Consequence |
|---|---|---|---|
| 1 | "the security group documents only 22/80, so 443 is closed" | **Wrong.** From the internet, `:443` answered `RST` (curl exit 7 = reachable but nothing listening) while `:3221`/`:8080` timed out (exit 28 = filtered). A 25-second temporary listener on `:443` then served a real `HTTP 200` to a public GET. | Nothing needs opening. Inbound 443 is already permitted; the port is simply unused. |
| 2 | "Let's Encrypt IP certificates are a 2026 feature; certbot ≥ 5.4 + webroot" | **Correct.** LE made 6-day and IP-address certificates generally available on 2026-01-15; certbot gained `--ip-address` in 5.3 and `webroot` support for IP identifiers in 5.4. Certs are 160 hours (= 6⅔ days) and IP certs *must* be short-lived. The `nginx` and `apache` installers do not support IP identifiers, so installation into nginx is manual and needs a `--deploy-hook`. | Feasible, but it is a ≥ 6-day renewal treadmill, not a 90-day one. |
| 3 | "the host can reach the ACME endpoint" (implied by "just add certbot") | **Partly.** TCP + TLS to `acme-v02.api.letsencrypt.org:443` works and `/directory` returns a real `HTTP 200` payload — **but only when the A record is supplied manually** (`curl --resolve`, or `nslookup … 223.5.5.5`). | Egress is fine. Name resolution is not. |
| 4 | "DNS is a detail" | **Wrong, and this is the real blocker.** The host's resolver (`systemd-resolved`, upstream `100.100.2.136/138`) fails for *every* name tested: `acme-v02.api.letsencrypt.org`, `letsencrypt.org`, `nodejs.org`, `baidu.com`, `mirrors.cloud.aliyuncs.com` all `FAIL`. A public resolver answers correctly, so the path is fine and the configured servers are not. | `certbot` cannot even locate the ACME directory. Fixing this is a **host-level** change, not an application one. |

Two further facts that shape the plan:

- **`certbot` is absent and cannot be installed the normal way.** `apt` mirrors are unreachable over
  80/443 and PyPI is unreachable, so `apt install certbot` / `pip install certbot` both fail. It
  would have to be transferred as a file and checksum-verified, exactly as the private Node runtime
  was (R6 §A did that with `node-v22.23.0-linux-x64.tar.xz`, verified against the publisher's
  `SHASUMS256.txt`).
- **`trustProxy: false` is a deliberate constant** (`apps/api/dist/app.js:39`). Behind nginx every
  request would arrive from `127.0.0.1`, which collapses the per-IP rate limits into a single global
  bucket: one abusive client could spend the whole login budget for everyone. That is design Q6/D14,
  not a bug, and it cannot be fixed by configuration.

## 2. Why the page cannot simply live at `https://<ip>/oel/`

The application is served from the **root** of an origin: the SPA build references `/assets/…`
absolutely, the session cookie is `Path=/`, and every API route is `/api/…`. There is no base-path
support. So a sub-path deployment would need a code change (base-path plumbing) that does not exist
today. Serving it on 443 therefore means the **HTTPS root of that IP becomes OpenEduLab**. That is a
public exposure decision, not a routing detail — the old games stay HTTP-only on port 80, untouched.

## 3. The minimal isolated plan (not applied)

Design rule: **every change is a new file plus a reload.** The existing site file
`/etc/nginx/sites-enabled/snake` (sha256 `eb7a7e5f…c0ec79`) is never edited, so its hash stays a valid
regression invariant.

### 3.0 Prerequisite the owner must decide first

| Order | Item | Why it is the owner's call |
|---|---|---|
| 1 | **Fix host DNS** (e.g. point `systemd-resolved` at a reachable resolver, or a pinned entry) | Host-wide change: it affects `apt`, `tailscale` behaviour and anything else that resolves names. |
| 2 | **Accept public exposure** of a login page on the shared VPS | R5's launch gates still stand: licence not chosen, service region not stated, retention window not chosen, and the owner must authorise going public explicitly. |
| 3 | **Accept a 6-day certificate** and its renewal dependency | Renewal failure is a hard outage within ~6 days, with no grace period. |

If any of the three is "no", the correct end state is exactly what R6 delivered: a loopback-only
instance reachable through an encrypted SSH forward, and **no public URL**.

### 3.1 Steps, in order, with the check that proves each one

1. **Make one directory for challenge files** (new, empty, served read-only):
   `/var/www/acme/.well-known/acme-challenge/` — nothing else lives there.
2. **Add `conf.d/openedulab-80-acme.conf`** — a *new* server block that matches the IP as `Host` and
   is otherwise a verbatim copy of the existing block's locations, plus one addition:
   ```nginx
   server {
       listen 80;
       server_name <ip>;                      # exact match beats the existing `server_name _`
       # … the existing locations copied verbatim: = /, = /play, /snake-ws, /snake,
       #   = /plane, /api/, /js/, /css/, = /teacher, = /favicon.ico, /d-…/, /xjtlu…/
       location /.well-known/acme-challenge/ { root /var/www/acme; default_type text/plain; }
       location / { proxy_pass http://127.0.0.1:8803; }   # same fallback as today
   }
   ```
   **The real risk here is drift, and it is not theoretical:** an exact-name server block takes over
   *all* paths for `Host: <ip>`, so any location not copied exactly silently changes an old route
   (e.g. forgetting `/plane` would send the plane game to the snake fallback). Verification is the
   sweep in §3.2. The alternative — adding one `location` to the existing file — is a smaller diff but
   breaks the "old file byte-identical" invariant, so it needs explicit approval.
3. **Obtain the certificate** (staging first, always):
   ```bash
   certbot certonly --staging --preferred-profile shortlived --webroot \
     --webroot-path /var/www/acme --ip-address <ip>
   # then without --staging for the publicly trusted certificate
   ```
   Prove: `certbot certificates` shows the IP identifier and a ~6-day expiry; the issued chain
   validates with `openssl verify` against the system trust store.
4. **Add `conf.d/openedulab-443.conf`** — new file, nothing else on 443 exists today:
   ```nginx
   server {
       listen 443 ssl;
       server_name <ip>;
       ssl_certificate     /etc/letsencrypt/live/<ip>/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/<ip>/privkey.pem;
       add_header Strict-Transport-Security "max-age=86400" always;   # 1 day, deliberately short
       location / { proxy_pass http://127.0.0.1:3221; proxy_set_header Host $host; }
   }
   ```
   Prove: `curl -I https://<ip>/` → `302` to `/login`, and a real browser sign-in issues
   `__Host-oel_sid` with `Secure`.
5. **Switch the instance to production semantics** only once 4 works: `OEL_ENV=production`,
   `OEL_PUBLIC_ORIGIN=https://<ip>`. Prove: cookie name/attributes, and that an HTTP request to the
   app is refused rather than downgraded.
6. **Renewal**: `certbot renew` on a timer that runs **twice a day** (a 6-day cert with daily
   renewal already leaves only one failed day of margin) plus `--deploy-hook "systemctl reload
   nginx"`. Prove: one forced renewal (`--dry-run` then a real early renewal) and a reload in the
   journal.
7. **Regression sweep after every reload** (§3.2) — before declaring anything online.

### 3.2 The sweep that must pass after each nginx reload

```
GET http://<ip>/            → 200  11978 B   <title>课堂游戏</title>
GET http://<ip>/snake       → 200 131380 B   (canvas build)
GET http://<ip>/plane       → 200  11201 B   <title>飞机大战 …</title>
GET http://<ip>/index.html  → 200 131380 B   (same body as /snake)
GET http://<ip>/api/        → 404  (pre-existing)
GET http://<ip>/snake-ws    → 502  (pre-existing: WS endpoint opened by a plain GET)
GET https://<ip>/           → 302 → /login, Set-Cookie: __Host-oel_sid=…; Secure; HttpOnly
```
The first six values are the R6 baseline (`docs/evidence/r6/baseline-before.txt`); any change in
status or size is a regression, not a detail.

## 4. Risks, and the honest cost of each

| Risk | Likelihood | Impact | Mitigation / position |
|---|---|---|---|
| Renewal fails → certificate expires in ≤ 6 days | moderate (new task, new host, broken DNS) | total outage; browsers show a hard error | twice-daily timer, `--deploy-hook` reload, alert on `certbot renew --dry-run` failure. A 6-day cert is not a fit-and-forget choice. |
| The new 80 block drifts from the old one and changes an old route | moderate | the classroom games break for every visitor | verbatim copy + §3.2 sweep after each reload; rollback is one `rm` + reload |
| Host DNS change has side effects | low–moderate | apt/tailscale/other resolution behaviour changes | change one resolver at a time, keep the current value to restore; verify the old games still serve |
| `trustProxy=false` collapses rate limits | certain once proxied | one client can exhaust the shared login budget; lockout timings become global | documented as Q6/D14. A real public deployment needs a proxy-trust change **with tests**, which is a code task, not a config task. R6 did not attempt it. |
| A bare-IP certificate is not a name | certain | no HSTS preload, no stable identity, cert must be re-issued if the IP changes; some client software treats IP-issued certs differently | acceptable for an owner-only test; **not** a substitute for a domain. Do not present it as a production identity. |
| Public login page on a shared host | certain | exposure of the app to the whole internet, with the R5 launch gates still open | requires explicit owner authorisation; not taken in R6 |
| Editing the old site file instead of adding a new one | — | violates the "old routes are immutable" rule | rejected; the plan adds files only |

## 5. Rollback (each step is independently reversible)

```
rm /etc/nginx/conf.d/openedulab-443.conf /etc/nginx/conf.d/openedulab-80-acme.conf
nginx -t && systemctl reload nginx          # 80 routing returns to the original single block
systemctl disable --now openedulab-test     # the instance itself, if it should stop
```
Removing the two files restores the exact pre-R6 nginx behaviour; the old site file was never
modified, so its sha256 remains `eb7a7e5f…c0ec79`. Certificates in `/etc/letsencrypt/` are inert once
nothing references them.

## 6. Decision for this round

**Not executed.** R6 stops at the server-internal instance because the first prerequisite in §3.0 —
repairing host DNS — is a host-wide change, and the second — public exposure — is the owner's
authorisation to give, not the agent's to assume. The measured good news is that the two things the
brief expected to be blocking (security group, ACME reachability) are not blocking at all; the two
real blockers are DNS and authorisation.
