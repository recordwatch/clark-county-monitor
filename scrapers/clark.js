import fs from 'fs';
import * as cheerio from 'cheerio';

const BASE_URL = 'https://clark.wa.gov';
export const ROSTER_URL = `${BASE_URL}/jail-services/jail-roster`;
export const RELEASES_URL = `${BASE_URL}/jail-services/recent-releases`;
const CHARGES_URL = `${BASE_URL}/jail-services/jail-roster/get-charges`;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
  'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5'
};

// Per-request cap. A stalled connection would otherwise hang the Actions job.
const REQUEST_TIMEOUT_MS = 30_000;

export async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retry wrapper. Backoff: 2s, 5s, 10s.
async function getWithRetry(url, attempts = 3) {
  const backoff = [2000, 5000, 10000];
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        console.error(`  Request failed (attempt ${i + 1}/${attempts}): ${err.message} — retrying in ${backoff[i] / 1000}s`);
        await delay(backoff[i]);
      }
    }
  }
  throw lastErr;
}

function clean(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

// "$750,000.00" -> 750000. Blank or $0 -> null.
function parseDollars(text) {
  const m = (text || '').match(/\$\s*([\d,]+\.?\d*)/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ''));
  return v > 0 ? v : null;
}

const pad = n => String(n).padStart(2, '0');

// Clark prints dates as "9/22/2026", "10/10/2026 4:20 AM" or
// "10/27/2026 09:00 AM" (Pacific local). Return "2026-09-22" for date-only
// values and "2026-10-10T04:20:00" when a time is present, so values sort as
// strings and date-only values stay visibly date-only.
export function toLocal(text) {
  const t = clean(text);
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM))?$/i);
  if (!m) return t || null;
  const [, mo, dd, yyyy, h, mi, ss, ampm] = m;
  const date = `${yyyy}-${pad(mo)}-${pad(dd)}`;
  if (!h) return date;
  let hour = parseInt(h, 10) % 12;
  if (ampm.toUpperCase() === 'PM') hour += 12;
  return `${date}T${pad(hour)}:${mi}:${ss || '00'}`;
}

// CFN looks like a per-person number (low CFNs show up on fresh bookings),
// so a booking is identified by CFN + book date. The roster only gives the
// date, so two bookings of one person on the same day would collide — rare.
export function bookingId(cfn, bookDate) {
  return `${cfn}-${(bookDate || '').replace(/\D/g, '')}`;
}

// The roster is one static table: CFN, name, book date, housing location,
// scheduled release date, and the top charge. Full charges come from
// fetchCharges().
export function parseRoster(html) {
  const $ = cheerio.load(html);
  const inmates = [];

  $('#inmate-table tbody tr').each((_, row) => {
    const tds = $(row).children('td').toArray().map(td => clean($(td).text()));
    const [cfn, name, bookDate, location, scheduledRelease, topCharge] = tds;
    if (!cfn || !name) return;
    const bookedAt = toLocal(bookDate);
    inmates.push({
      id: bookingId(cfn, bookedAt),
      cfn,
      name,
      bookedAt,
      location: location || null,
      scheduledRelease: toLocal(scheduledRelease),
      topCharge: topCharge || null
    });
  });

  return inmates;
}

// Columns: RCW, Charge #, Class, LEA, Court, Court Date, Description,
// Cit/Wt/Cause#, Bail Type, Bail Amount, Release Type.
export function parseChargesTable(html) {
  const $ = cheerio.load(html);
  const charges = [];
  $('tbody tr').each((_, tr) => {
    // toArray() rather than .map().get(): cheerio's map drops null results,
    // which would shift every column after an empty cell.
    const tds = $(tr).find('td').toArray().map(td => clean($(td).text()) || null);
    if (!tds[6]) return;
    charges.push({
      description:  tds[6],
      rcw:          tds[0],
      chargeNumber: tds[1],
      class:        tds[2],
      agency:       tds[3],
      court:        tds[4],
      courtDate:    toLocal(tds[5]),
      caseNumber:   tds[7],
      bailType:     tds[8],
      bailAmount:   parseDollars(tds[9]),
      releaseType:  tds[10]
    });
  });
  return charges;
}

// Returns null when there's nothing usable — the endpoint answers released
// CFNs with an HTML error page instead of JSON, and callers must keep the
// charges they already have.
export async function fetchCharges(cfn) {
  try {
    const body = await getWithRetry(`${CHARGES_URL}?cfn=${encodeURIComponent(cfn)}&format=json`, 2);
    const data = JSON.parse(body);
    if (!Array.isArray(data) || !data[0]?.charges) return null;
    const charges = parseChargesTable(data[0].charges);
    return charges.length ? charges : null;
  } catch (err) {
    console.error(`  Charges fetch failed for ${cfn}: ${err.message}`);
    return null;
  }
}

// "Recent Releases": CFN, name, book date, release date+time, status.
export function parseReleases(html) {
  const $ = cheerio.load(html);
  const releases = [];
  $('#release-table tbody tr').each((_, row) => {
    const tds = $(row).children('td').toArray().map(td => clean($(td).text()));
    if (!tds[0]) return;
    releases.push({
      cfn: tds[0],
      name: tds[1],
      bookedAt: toLocal(tds[2]),
      releasedAt: toLocal(tds[3]),
      releaseStatus: tds[4] || null
    });
  });
  return releases;
}

// Set ROSTER_HTML_FILE / RELEASES_HTML_FILE to parse saved copies instead of
// fetching (handy for testing offline).
async function load(url, fileEnv) {
  return process.env[fileEnv] ? fs.readFileSync(process.env[fileEnv], 'utf-8') : getWithRetry(url);
}

export async function fetchRoster() {
  return parseRoster(await load(ROSTER_URL, 'ROSTER_HTML_FILE'));
}

// Non-fatal: a failed releases fetch just means release times fall back to
// "when we noticed", so return [] instead of throwing.
export async function fetchRecentReleases() {
  try {
    return parseReleases(await load(RELEASES_URL, 'RELEASES_HTML_FILE'));
  } catch (err) {
    console.error('Releases fetch failed:', err.message);
    return [];
  }
}
