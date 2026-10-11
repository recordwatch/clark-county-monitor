# Clark Jail Roster — Project Context

## What it is
A public jail roster monitor for Clark County, WA, built from the same
template as `recordwatch/lewis-county-monitor` and
`recordwatch/cowlitz-county-monitor` (modeled on the Kitsap monitor).
Scrapes the jail roster every 30 minutes, tracks bookings and releases, and
serves a static site.

## Sources
- https://clark.wa.gov/jail-services/jail-roster — Drupal page with one
  static table (`#inmate-table`): CFN, name, book **date only**, housing
  location, scheduled release date, top charge.
- `https://clark.wa.gov/jail-services/jail-roster/get-charges?cfn=<CFN>&format=json`
  — full charges per person as JSON wrapping an HTML table (RCW, class, LEA,
  court, court date, description, case #, bail type/amount, release type).
  For released CFNs it returns an HTML error page, so charges must be
  captured while the person is in custody.
- https://clark.wa.gov/jail-services/recent-releases — `#release-table` with
  CFN, release date+time, and status. Matched to bookings by CFN.

## Architecture
- **Scraper:** `scrape.js` (orchestrator) + `scrapers/clark.js` (Cheerio parsing), Node 20 built-in fetch
- **Schedule:** `.github/workflows/scrape.yml`, cron every 30 min
- **Storage:** JSON committed to `data/` — no server, no database
- **Frontend:** React + Vite in `frontend/`, built and pushed to the `gh-pages` branch

## Key facts / gotchas
- Charges cost one request per person. Each run fetches new bookings plus
  `REFRESH_PER_RUN` (60) least-recently-checked people, 300 ms apart, so
  everyone refreshes about every 4 hours. The first run fetches all ~470.
- Booking `id` is `<CFN>-<book date digits>`. In-custody people are also
  matched **by CFN**, so a book date the county adds or corrects later
  updates the record instead of logging a false release. Rows with no book
  date are keyed `<CFN>-seen<first-seen date>`.
- Book dates have no time. For bookings we watched happen, `firstSeen` is
  used as the start time for length-of-stay; baseline entries use the date.
- Date-only strings (`YYYY-MM-DD`) must be parsed as local midnight
  (append `T00:00:00`) — JS parses bare dates as UTC.
- Bail marked `COMBINED` repeats another charge's amount; `bondTotal` sums
  only non-combined amounts (falls back to the largest).
- Charge class: FA/FB/FC = Class A/B/C felony, GM = gross misdemeanor,
  M = misdemeanor. Courts: `S*` Superior, `D*` District. Only VPD and WSP
  agency codes are named; SO6, CLS, etc. show as-is until confirmed.
- Release: `releaseSource: 'official'` when found on Recent Releases (with
  `releaseStatus`), else `'observed'` (scrape time) and retried for two days.
- Safety: if the roster comes back empty or < 50% of the previous in-custody
  count, the run exits non-zero without marking anyone released.

## Data files
- `data/change_log.json` — every booking ever seen, newest `bookedAt` first
- `data/stats.json` — precomputed stats (`stats.js`)
- `data/status.json` — `{ inCustody, lastUpdated }`

## Local dev
- `ROSTER_HTML_FILE=r.html RELEASES_HTML_FILE=rel.html SKIP_CHARGES=1 node scrape.js`
  parses saved pages without hitting the charges endpoint
- Frontend: copy `data/*.json` into `frontend/public/data/`, then `cd frontend && npm run dev`
