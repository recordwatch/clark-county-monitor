// Timestamps are Pacific local strings: "2026-10-10T04:26:29".
// Format them by slicing the string rather than via Date, so the display
// doesn't shift if the viewer is in a different time zone.

export function formatDate(ts) {
  if (!ts) return ''
  const [y, m, d] = ts.slice(0, 10).split('-')
  return `${m}/${d}/${y.slice(2)}`
}

export function formatTime(ts) {
  if (!ts || ts.length < 16) return ''
  let h = parseInt(ts.slice(11, 13), 10)
  const min = ts.slice(14, 16)
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${h}:${min} ${ampm}`
}

export function formatDateTime(ts) {
  return ts ? `${formatDate(ts)} ${formatTime(ts)}`.trim() : ''
}

// Date-only strings ("2026-09-22") parse as UTC in JS; add a time so they
// parse as local midnight like full timestamps do.
function toDate(ts) {
  return new Date(ts.length === 10 ? `${ts}T00:00:00` : ts)
}

export function formatMoney(n) {
  if (n == null) return null
  return '$' + Number(n).toLocaleString('en-US')
}

export function timeHeld(start, end) {
  if (!start || !end) return null
  const ms = toDate(end) - toDate(start)
  if (!(ms > 0)) return null
  const totalMins = Math.floor(ms / 60000)
  const days = Math.floor(totalMins / 1440)
  const hours = Math.floor((totalMins % 1440) / 60)
  const mins = totalMins % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

export const AGENCY_NAMES = {
  VPD: 'Vancouver PD',
  WSP: 'Washington State Patrol'
}

// Standard Washington offense classes.
export const CLASS_NAMES = {
  FA: 'Class A Felony',
  FB: 'Class B Felony',
  FC: 'Class C Felony',
  GM: 'Gross Misdemeanor',
  M:  'Misdemeanor'
}

export function agencyName(code) {
  return AGENCY_NAMES[code] || code || 'N/A'
}

export function className(code) {
  return CLASS_NAMES[code] || code
}

// "S3" -> "Superior Court (S3)". The prefix is clear; department numbers aren't.
export function courtName(code) {
  if (!code) return code
  if (/^S/.test(code)) return `Superior Court (${code})`
  if (/^D/.test(code)) return `District Court (${code})`
  return code
}

// The roster only gives a booking date. For bookings we watched happen,
// firstSeen (within ~30 min of booking) is the better start time.
export function bookingStart(entry) {
  return !entry.baseline && entry.firstSeen ? entry.firstSeen : entry.bookedAt
}

// "~" marks release times we estimated (first scrape they were missing)
// rather than read from the official Recent Releases page.
export function releaseTime(entry, fmt) {
  return (entry.releaseSource === 'official' ? '' : '~') + fmt(entry.releasedAt)
}
