# R7 evidence — curriculum contexts and context-scoped saved parameters

Collecting evidence of what actually ran, not what was intended. All commands were run on
the working machine in `G:/hermes/projects/openedulab`, Node `v22.23.0`.

| File | What it is |
|---|---|
| `test-red-api.txt` | RED, before any API/domain code: `apps/api/test/curriculum.test.ts` → 24 failed / 2 passed (routes 404, `placements` absent). |
| `test-red-web.txt` | RED, before the web implementation: `host-context-state`, `curriculum-page`, `router` → 13 failed / 24 passed (no `context`/`parameter-origin`/`CurriculumPage`, no `/curriculum` route). |
| `check-r7.txt` | `npm run check` → exit 0: web 11 files / 133 tests, API 24 files / 356 tests, lint/typecheck silent, `validate-content` OK (2 placements, 157 keys per UI locale), both builds successful. Parent review added a regression for the label after reset → save. |
| `smoke-r7.txt` | `npm run smoke:api` against a real process/socket → 124/124 checks passed, including anonymous 401 on `/api/curriculum` and `/api/me/placement-state`, chapter-scope isolation, stale-version 409, crafted id 400, no DELETE endpoint, and migrations `0001+0002`. |
| `e2e-full.txt` | `npx playwright test` (4 projects) → 82 passed / 64 skipped / 0 failed, exit 0. All skips are explicit `test.skip(project…)`. |
| `backup-r7.txt` | `npm run check:backup` PASS — nine tables counted (includes `placement_saved_state: 1`), `integrity_check=ok`, migrations `["0001","0002"]`. |
| `restore-r7.txt` | `npm run check:restore` PASS — restored database reports `applied=2`, `latest=0002`, `healthz=ok`, write probe 201. |
| `retention-r7.txt` | `npm run retention:dry-run` → 0 rows to delete. |
| `curriculum-directory.png` | `/curriculum` with the two pilot entries and their "not a textbook chapter" badge. |
| `chapter-a-saved.png`, `chapter-a-reset-kept.png` | Chapter A preset → saved snapshot → reset (snapshot kept, API still 200). |
| `chapter-b-preset.png`, `chapter-mobile.png` | Chapter B preset; phone viewport without horizontal scrolling. |
| `direct-defaults.png`, `direct-saved.png`, `direct-reset-kept.png` | Direct tool entry: defaults, saved snapshot, reset that keeps the snapshot. |
| `direct-other-account.png`, `direct-mobile.png` | Second account sees its own defaults; phone viewport. |

Notes:
- The screenshots are produced by the specs themselves (`shot(page, 'r7', …)`), so they
  always correspond to the build under test.
- No VPS, nginx, firewall, DNS, credential or GitHub deployment action was taken in R7; the
  test server is `scripts/e2e-server.mjs` on `127.0.0.1:3220` and is torn down by Playwright.
