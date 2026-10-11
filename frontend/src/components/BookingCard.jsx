import { useState } from 'react'
import {
  formatDate, formatTime, formatDateTime, formatMoney, timeHeld,
  agencyName, className, courtName, bookingStart, releaseTime
} from '../format'

export default function BookingCard({ entry }) {
  const [open, setOpen] = useState(false)

  const isReleased = entry.status === 'released'
  const held = isReleased ? timeHeld(bookingStart(entry), entry.releasedAt) : null
  // Roster gives a date only; show when we first saw them for new bookings.
  const seen = !entry.baseline && entry.firstSeen ? ` (seen ${formatTime(entry.firstSeen)})` : ''

  return (
    <div className={`card ${isReleased ? 'card-released' : 'card-custody'}`}>
      <div className="card-header" onClick={() => setOpen(!open)}>
        <div className="card-left">
          <div className="card-name">{entry.name}</div>
          <div className="card-meta">
            CFN {entry.cfn} &nbsp;·&nbsp; Booked: {entry.bookedAt ? formatDate(entry.bookedAt) : 'N/A'}{seen}
            {held && <span className="card-time-held"> &nbsp;·&nbsp; Held: {held}</span>}
          </div>
        </div>
        <div className="card-right">
          <span className={`badge ${isReleased ? 'badge-released' : 'badge-custody'}`}>
            {isReleased ? 'Released' : 'In Custody'}
          </span>
          <span className="card-toggle">{open ? '▲' : '▼'}</span>
        </div>
      </div>

      {open && (
        <div className="card-body">
          {isReleased && entry.releasedAt && (
            <div className="card-release-row">
              Released: {releaseTime(entry, formatDateTime)}
              {entry.releaseStatus && <> &nbsp;·&nbsp; {entry.releaseStatus}</>}
              {held && <span className="card-time-held-detail"> &nbsp;·&nbsp; Time held: {held}</span>}
            </div>
          )}
          {!isReleased && entry.scheduledRelease && (
            <div className="card-release-row">Scheduled release: {formatDate(entry.scheduledRelease)}</div>
          )}

          <div className="card-description">
            <div className="desc-row">
              <span>Location</span><span>{entry.location || 'N/A'}</span>
            </div>
            <div className="desc-row">
              <span>Arresting Agency</span><span>{agencyName(entry.arrestingAgency)}</span>
            </div>
            <div className="desc-row">
              <span>Bail Total</span><span>{formatMoney(entry.bondTotal) || 'None'}</span>
            </div>
          </div>

          <div className="card-charges">
            {entry.charges?.length > 0 ? (
              <>
                <div className="charges-title">Charges ({entry.charges.length})</div>
                {entry.charges.map((c, i) => (
                  <div key={i} className="charge-row">
                    <div className="charge-violation">
                      {c.description}
                      {c.class && <span className="charge-add-desc"> — {className(c.class)}</span>}
                    </div>
                    {c.court && (
                      <div className="charge-court">
                        {courtName(c.court)}{c.courtDate && ` · next date ${formatDateTime(c.courtDate)}`}
                      </div>
                    )}
                    {(c.bailType || c.bailAmount) && (
                      <div className="charge-bail">
                        Bail: {[c.bailType, formatMoney(c.bailAmount)].filter(Boolean).join(' · ')}
                      </div>
                    )}
                    {c.agency && <div className="charge-agency">Arrested by: {agencyName(c.agency)}</div>}
                    {c.releaseType && <div className="charge-clearance">Release type: {c.releaseType}</div>}
                  </div>
                ))}
              </>
            ) : (
              entry.topCharge && (
                <>
                  <div className="charges-title">Top charge</div>
                  <div className="charge-row"><div className="charge-violation">{entry.topCharge}</div></div>
                </>
              )
            )}
          </div>
        </div>
      )}
    </div>
  )
}
