# ADHMAT platform (local deployment)

Website, State of Digital Health dashboard and a REDCap-to-dashboard pipeline in one program. Runs on your own computer or server. **No installation of packages is needed**: only Node.js 18 or newer.

## Start

```
node server.js          (or: npm start)
```
Windows: double-click `start.bat`. Then open:

| Address | What |
|---|---|
| http://127.0.0.1:8080/ | Website (home, about, tool, roadmap, FAQ) |
| http://127.0.0.1:8080/dashboard.html | Dashboard inside the site (full screen: `/dashboard/`) |
| http://127.0.0.1:8080/admin.html | Data & pipeline: status, sync, upload, history, dictionary |

On first start an **admin key** is printed in the console and saved in `data/admin.key`. Without REDCap settings the site works with **generated test data**.

## Connect REDCap (no column mapping)

1. In REDCap, create an API token for the ADHMAT project (a user with *API Export* rights; export rights to the ADHMAT instrument are enough). 
2. Copy `.env.example` to `.env` and set `REDCAP_API_URL` (ends in `/api/`) and `REDCAP_API_TOKEN`. Restart.
3. Open **Data & pipeline**, enter the admin key, press **Test REDCap connection**, then **Sync now**.
4. The dashboard switches to **Live** data by itself and open dashboards refresh.

Schedule: `config/adhmat.config.json` → `sync` (`intervalMinutes`, `atTimes` such as `["06:00","14:00"]`, `onStart`). 
Near-real-time: in REDCap *Project Setup → Additional customizations → Data Entry Trigger* paste the address shown on the Data & pipeline page. Bursts of saves collapse into one sync (`webhookDebounceSeconds`). REDCap must be able to reach this server; if it cannot, rely on the schedule.

### How the mapping works
The pipeline reads the REDCap data dictionary (`dictionary/…2026-11-03.csv`, and the live form through `content=metadata` at every sync) and derives:
- the 373 questions, with domain, sub-domain, maturity step and text (from `q_*` and the `h_<domain>_<sub>_y` calculated fields REDCap uses for scoring);
- Digital Payment Systems questions (`q_dps*`), 55 Member States and Regional Collaborating Centres (`country_*`, `rcc`), the 10 priority questions with document upload (`up_*`), maturity thresholds (`result_*_lvl`), answer codes, Module 2 fields, consent/contact choices.
If the form changes in REDCap, the next sync rebuilds this mapping and logs what changed. If the new form is not a valid ADHMAT form, the last good data stays on the dashboard and the problem is shown.
Only the fields the dashboard needs are requested (431 of 1005). **Focal-point names, emails, phones and the Module 2 free-text answers are never requested or stored.**

### Scoring (ADHMAT V2.5, same as the REDCap calculations)
Sub-domain % = Yes ÷ (Yes + No), N/A and blanks excluded; domain = mean of its sub-domains; overall = mean of domains A–E (Digital Payment Systems reported separately); levels L1 <40, L2 40–54.9, L3 55–69.9, L4 70–84.9, L5 ≥85. Each import is also compared with REDCap's own `result_*_score` fields and any mismatch is reported as a warning.

## Upload instead of API
**Data & pipeline → Upload a REDCap export.** Use *CSV / Microsoft Excel (raw data)*. The file is validated first (dry run); nothing is stored until you confirm. **Download a test export** gives a file in the right format.

## Test data and live data
Both are kept. The dashboard header has a **Live / Test data** switch (per visitor). Admins choose the default on the Data & pipeline page (automatic = live when it exists). Test data is generated (55 countries) from the dashboard design and is always labelled.
Every import or sync is kept as a **snapshot** (last 40); any can be restored from the admin page. Raw uploads are archived in `data/imports/`.

## API
Public (read): `GET /api/health`, `/api/status`, `/api/data?source=auto|live|test` (ETag, gzip), `/api/events` (server-sent events), `/api/dictionary/summary|questions|countries`, `/api/test/redcap-export.csv`.
Admin (header `X-Admin-Key`): `POST /api/sync`, `POST /api/ingest[?dry=1]` (CSV or JSON body), `GET /api/sync/history`, `GET /api/snapshots`, `POST /api/snapshots/<id>/activate`, `POST /api/source`, `POST /api/dictionary[?dry=1]`, `POST /api/admin/redcap-test`, `GET /api/admin/info`.
REDCap: `POST /api/webhook/redcap?key=<secret>` (Data Entry Trigger).

## Security
- Listens on `127.0.0.1` only. To share on a network set `HOST=0.0.0.0` **and put HTTPS in front** (reverse proxy such as Caddy, nginx or IIS); the admin key and webhook secret otherwise travel in clear text.
- API token and keys live in `.env` / `data/` (git-ignored), never in the website. Admin attempts are throttled; comparisons are constant-time; static files cannot leave `public/`.
- The dashboard shows named results. Check each country's data-use consent (answers 2 and 3 mean *aggregated* / *not for publication*) before sharing outside Africa CDC; imports list countries with restricted consent.

## Run as a service
Linux (systemd): `ExecStart=/usr/bin/node /opt/adhmat-platform/server.js`, `WorkingDirectory=/opt/adhmat-platform`, `Restart=on-failure`. Windows: Task Scheduler "At startup" running `start.bat`, or NSSM. Back up the `data/` folder.

## Tests
`npm test` (26 tests, no dependencies): dictionary derivation, scoring and boundaries, import edge cases, API, security, sync against a mock REDCap, webhook, failures, schedule, form-change detection.
`node scripts/mock-redcap.js` starts a mock REDCap API for trying the pipeline without a project. `node scripts/e2e-browser.js` (needs Playwright) drives the site in a browser.
`node scripts/build-dashboard.js` rebuilds `public/dashboard/` from `scripts/source/…Standalone_4.html` (design unchanged).

## Known points to confirm
1. **Module 2 is narrative-only in the 3 Nov dictionary.** The dashboard's structured Module 2 charts (initiative stage, barriers, support sources, emerging developments, factors) have no data source and show "not captured" for live data. New cards show narrative progress, consent, follow-up and evidence uploads. Decide whether to restore structured fields in REDCap or retire those charts.
2. **Mauritius** is in the Southern RCC in the dictionary; the dashboard design data had it under East. Live data follows REDCap.
3. N/A needs a justification in the V2.5 workbook; the REDCap form has no justification field, so N/A is simply excluded (as the REDCap calculations do).
4. The L4 label is "Advanced" here (as in the dashboard); project instructions say "Advanced/Institutionalized".
