import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchRoster, fetchRecentReleases, fetchCharges, delay } from './scrapers/clark.js';
import { nowLocalIso } from './utils.js';
import { buildStats } from './stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR = path.join(__dirname, 'data');
fs.mkdirSync(STORAGE_DIR, { recursive: true });

const LOG_FILE    = path.join(STORAGE_DIR, 'change_log.json');
const STATS_FILE  = path.join(STORAGE_DIR, 'stats.json');
const STATUS_FILE = path.join(STORAGE_DIR, 'status.json');

// If the roster suddenly shrinks below this fraction of who we think is in
// custody, assume the page is broken/partial rather than mass release, and
// don't mark anyone released this run.
const MIN_ROSTER_RATIO = 0.5;

// Charges cost one request per person. Each run fetches them for new
// bookings plus this many existing inmates (least recently checked first),
// so ~470 people cycle through about every 4 hours instead of hitting the
// county's server ~940 times an hour.
const REFRESH_PER_RUN = Number(process.env.REFRESH_PER_RUN ?? 60);
const CHARGES_DELAY_MS = 300;

function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    console.error(`Could not parse ${file}: ${e.message}`);
    process.exit(1); // never overwrite history with an empty array
  }
  return fallback;
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

// Bail marked COMBINED repeats another charge's amount (e.g. two charges
// both showing $750,000), so summing every charge would double-count.
// Sum the non-combined amounts; if that's nothing, take the largest.
function bondTotal(charges) {
  const amounts = charges.filter(c => c.bailAmount);
  const sum = amounts.filter(c => c.bailType !== 'COMBINED').reduce((s, c) => s + c.bailAmount, 0);
  if (sum > 0) return sum;
  return amounts.length ? Math.max(...amounts.map(c => c.bailAmount)) : null;
}

function applyCharges(entry, charges, now) {
  entry.chargesCheckedAt = now;
  if (!charges) return; // keep what we have — released CFNs return nothing
  entry.charges = charges;
  entry.bondTotal = bondTotal(charges);
  entry.arrestingAgency = charges[0]?.agency || entry.arrestingAgency || null;
}

async function run() {
  const now = nowLocalIso();
  console.log(`[${now}] Running scrape...`);

  // change_log.json is every booking we've ever seen, newest booking first.
  // Entries are updated in place (charges refresh, release).
  const log = readJSON(LOG_FILE, []);
  const isFirstRun = log.length === 0;

  let inmates;
  try {
    inmates = await fetchRoster();
  } catch (err) {
    console.error('Roster fetch failed:', err.message);
    process.exit(1);
  }

  const byId = new Map(log.map(e => [e.id, e]));
  const wasInCustody = log.filter(e => e.status === 'in_custody');
  // A person has at most one open booking, so match in-custody people by CFN
  // too. Otherwise a book date the county fills in or corrects later would
  // change the id and log a false release + new booking.
  const inCustodyByCfn = new Map(wasInCustody.map(e => [e.cfn, e]));

  if (inmates.length === 0 || (wasInCustody.length > 20 && inmates.length < wasInCustody.length * MIN_ROSTER_RATIO)) {
    console.error(`Got ${inmates.length} inmates (expected ~${wasInCustody.length}) — skipping diff to avoid false releases.`);
    process.exit(1);
  }

  const currentIds = new Set();
  const needCharges = [];

  for (const inmate of inmates) {
    const existing = byId.get(inmate.id) || inCustodyByCfn.get(inmate.cfn);
    if (existing) {
      if (currentIds.has(existing.id)) continue;
      currentIds.add(existing.id);
    } else {
      // Some rows have no book date; key those on the day we first saw them.
      if (!inmate.bookedAt) inmate.id = `${inmate.cfn}-seen${now.slice(0, 10).replace(/-/g, '')}`;
      if (currentIds.has(inmate.id)) continue;
      currentIds.add(inmate.id);
    }

    if (!existing) {
      console.log(`  NEW: ${inmate.name} (${inmate.cfn})`);
      const entry = {
        ...inmate,
        charges: [],
        bondTotal: null,
        arrestingAgency: null,
        chargesCheckedAt: null,
        status: 'in_custody',
        // The roster only gives a booking date; firstSeen is the closest
        // thing to a booking time for bookings we watch happen.
        firstSeen: now,
        releasedAt: null,
        releaseStatus: null,
        releaseSource: null,
        // true = already in jail when monitoring started, so we didn't watch
        // this booking happen. Stats use it to avoid skewed "new booking" counts.
        baseline: isFirstRun
      };
      log.push(entry);
      byId.set(entry.id, entry);
      needCharges.push(entry);
      continue;
    }

    // Still in custody: refresh fields that change during a stay.
    existing.status = 'in_custody';
    existing.releasedAt = null;
    existing.releaseStatus = null;
    existing.releaseSource = null;
    existing.name = inmate.name;
    if (inmate.bookedAt) existing.bookedAt = inmate.bookedAt;
    existing.location = inmate.location;
    existing.scheduledRelease = inmate.scheduledRelease;
    existing.topCharge = inmate.topCharge || existing.topCharge;
  }

  // Charges: everyone new, then the least recently checked in-custody people.
  const newIds = new Set(needCharges.map(e => e.id));
  const refresh = log
    .filter(e => e.status === 'in_custody' && currentIds.has(e.id) && !newIds.has(e.id))
    .sort((a, b) => (a.chargesCheckedAt || '').localeCompare(b.chargesCheckedAt || ''))
    .slice(0, REFRESH_PER_RUN);
  const toFetch = [...needCharges, ...refresh];
  if (process.env.SKIP_CHARGES) toFetch.length = 0;

  console.log(`[${nowLocalIso()}] Fetching charges for ${needCharges.length} new + ${refresh.length} refresh...`);
  let chargeFailures = 0;
  for (const entry of toFetch) {
    const charges = await fetchCharges(entry.cfn);
    if (!charges) chargeFailures++;
    applyCharges(entry, charges, now);
    await delay(CHARGES_DELAY_MS);
  }
  console.log(`[${nowLocalIso()}] Charges done. ${toFetch.length - chargeFailures} ok, ${chargeFailures} empty/failed.`);

  // Release time and status come from "Recent Releases", matched by CFN.
  // If they're not listed (yet), fall back to the scrape where they went
  // missing (accurate to ~30 min); later runs retry for two days.
  const recentReleases = await fetchRecentReleases();
  function officialRelease(entry) {
    const matches = recentReleases.filter(r =>
      r.cfn === entry.cfn && r.releasedAt && r.releasedAt >= (entry.bookedAt || '')
    );
    // Latest release for that CFN, in case they were in and out twice.
    return matches.sort((a, b) => b.releasedAt.localeCompare(a.releasedAt))[0] || null;
  }

  let releasedCount = 0;
  for (const entry of wasInCustody) {
    if (currentIds.has(entry.id)) continue;
    const official = officialRelease(entry);
    console.log(`  RELEASED: ${entry.name} (${entry.cfn})${official ? ` at ${official.releasedAt}` : ''}`);
    entry.status = 'released';
    entry.releasedAt = official?.releasedAt || now;
    entry.releaseStatus = official?.releaseStatus || null;
    entry.releaseSource = official ? 'official' : 'observed';
    releasedCount++;
  }

  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  for (const entry of log) {
    if (entry.status !== 'released' || entry.releaseSource !== 'observed') continue;
    if ((entry.releasedAt || '') < twoDaysAgo) continue;
    const official = officialRelease(entry);
    if (!official) continue;
    entry.releasedAt = official.releasedAt;
    entry.releaseStatus = official.releaseStatus;
    entry.releaseSource = 'official';
    console.log(`  Matched release time for ${entry.name}: ${official.releasedAt}`);
  }

  // Newest booking first; within a day, most recently first seen first.
  log.sort((a, b) =>
    (b.bookedAt || '').localeCompare(a.bookedAt || '') || (b.firstSeen || '').localeCompare(a.firstSeen || '')
  );

  writeJSON(LOG_FILE, log);
  writeJSON(STATUS_FILE, { inCustody: currentIds.size, lastUpdated: now });
  writeJSON(STATS_FILE, buildStats(log, now));
  console.log(`[${nowLocalIso()}] Done. ${needCharges.length} new, ${releasedCount} released, ${currentIds.size} in custody.`);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
