# R6 evidence — server-internal test deployment

All files here are plain-text captures of real runs on 2026-10-27. The host address is withheld
(`<test-host>`) because this repository is public; the account identifiers are invented test
identities (`r6.alpha@example.test`, `r6.beta@example.test`) whose passwords exist only in the
throwaway verification scripts.

| File | What it proves |
|---|---|
| `baseline-before.txt` | The four pre-existing routes (`/`, `/snake`, `/plane`, `/index.html`) answered `200` with exact byte counts and body hashes, and `/snake-ws` `502` / `/api/` `404` were already the pre-work state. Measured over the public internet with plain GET. |
| `baseline-after.txt` | The same measurement after the deployment and every verification step. Diff against `baseline-before.txt`: timestamps only. |
| `artifact.txt` | Provenance of what was deployed: source commit `eac40c0` (= remote `main`, clean tree), Node `22.23.0` tarball verified against the publisher's `SHASUMS256.txt` both locally and on the server, the application archive's sha256, the production-only dependency set, and the five file hashes that were read back from the server and matched the local build byte for byte. |
| `deployment.txt` | Layout, ownership, environment file, the systemd unit and its *effective* hardening, the fail-closed startup proof, and the explicit list of things that were not touched. |
| `acceptance.txt` | One continuous run: anonymous surface → sign-in through the real form → catalog → experiment → saved snapshot read back → **process restart** (PID before/after, old services re-checked, nginx hash re-checked) → the pre-restart session still authenticating → a second account seeing nothing → logout revoking only that session. |
| `server-facts.txt` | Post-run state: unit active/enabled, loopback-only listener, healthz with `migrations.pending: 0`, the anonymous status codes for every protected route (`401` for account data, `404` for the operator channel and events), the old services still `200`, nginx hash unchanged, no 443 listener, tree ownership and sizes. |
| `db-readback.txt` | The database read directly in read-only mode (independent of HTTP): `integrity_check=ok`, WAL, one migration, row counts, `scrypt$327…` hash shape, the stored snapshot, and `event`/`feedback`/`internal_audit` at **0** because diagnostics are off and the operator channel is not mounted. |
| `https-probes.txt` | The inputs to the HTTPS assessment: host DNS failing for every name while a public resolver answers, the ACME endpoint reachable over TCP+TLS once the address is supplied, `certbot` absent with apt/PyPI unreachable, the nginx layout, and the `trustProxy: false` constant. |
| `port443.txt` | Inbound 443 measured from the internet: a bounded 25-second temporary listener served a real `HTTP 200`, then was killed and the port returned to no listener. No configuration, firewall or security-group change was made. |

What is **not** here, on purpose: no public URL, no certificate, no nginx change, no credentials, no
real personal data, and no claim that the instance is reachable from the internet.
