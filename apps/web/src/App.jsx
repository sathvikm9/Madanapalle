import { useEffect, useMemo, useState } from "react";
import { demoDashboard } from "./demo.js";

const API_BASE = (import.meta.env.VITE_API_BASE || "http://localhost:8787").replace(/\/$/, "");
const inDemoMode = new URLSearchParams(window.location.search).get("demo") === "1";
const THEATRE_OPTIONS = [
  { code: "ALL", shortName: "All theatres" },
  { code: "SKMD", shortName: "Sri Krishna" },
  { code: "RTDM", shortName: "Ravi" }
];

function indiaToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}

const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("en-IN");
const dateTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit"
});
const displayDate = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", day: "2-digit", month: "long", year: "numeric"
});

function StatusPill({ status }) {
  const labels = { completed: "Final", scheduled: "Scheduled", capturing: "Capturing", missed: "Missed", replaced: "Replaced", removed: "Removed" };
  return <span className={`status status--${status}`}>{labels[status] || status}</span>;
}

function Metric({ label, value, note, tone }) {
  return (
    <article className={`metric ${tone ? `metric--${tone}` : ""}`}>
      <span className="metric__label">{label}</span>
      <strong>{value}</strong>
      <span className="metric__note">{note}</span>
    </article>
  );
}

function ShowCard({ show }) {
  const [open, setOpen] = useState(false);
  const prices = (show.snapshot?.categories || show.advertisedCategories || []).map((category) => ({
    name: category.name,
    list: category.listPricePaise,
    net: category.netPricePaise ?? Math.max(category.listPricePaise - 500, 0),
    sold: category.sold,
    capacity: category.capacity,
    collection: category.collectionPaise
  }));

  return (
    <article className={`show-card ${!show.isCurrent ? "show-card--history" : ""}`}>
      <header className="show-card__header">
        <div className="show-card__identity">
          <span>{show.venueShortName || show.venueName || show.venueCode}</span>
          <i aria-hidden="true">—</i>
          <time>{show.showTime}</time>
        </div>
        <StatusPill status={show.status} />
      </header>

      <div className="show-card__content">
        <div className="show-card__movie">
          <h3>{show.movieTitle}</h3>
          <p>{[show.language, show.format].filter(Boolean).join(" · ") || "Details unavailable"}</p>
        </div>

        <div className={`show-card__result ${show.snapshot ? "" : "show-card__result--pending"}`}>
          {show.snapshot ? (
            <>
              <div><span>Tickets</span><strong>{number.format(show.snapshot.sold)}</strong></div>
              <div><span>Gross</span><strong>{money.format(show.snapshot.collectionPaise / 100)}</strong></div>
            </>
          ) : (
            <div className="pending-copy">
              <span>Capture window</span>
              <strong>{dateTime.format(new Date(show.captureDueAt))}</strong>
              <small>Final attempt {dateTime.format(new Date(show.finalCaptureDueAt || show.captureDueAt))}</small>
            </div>
          )}
        </div>
      </div>

      <footer className="show-card__meta">
        {show.snapshot ? (
          <span>Captured {dateTime.format(new Date(show.snapshot.capturedAt))} · {show.snapshot.occupancyPercent}% occupancy</span>
        ) : (
          <span>Booking cutoff {dateTime.format(new Date(show.cutoffAt))}</span>
        )}
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          {open ? "Hide breakdown" : "Price breakdown"}
        </button>
      </footer>
      {open && (
        <div className="price-table" role="region" aria-label={`${show.showTime} price breakdown`}>
          <div className="price-table__head"><span>Class</span><span>Listed → MC adjusted</span><span>Sold</span><span>Gross</span></div>
          {prices.map((category) => (
            <div className="price-table__row" key={category.name}>
              <span data-label="Class">{category.name}</span>
              <span data-label="Price">{money.format(category.list / 100)} → {money.format(category.net / 100)}</span>
              <span data-label="Sold">{category.sold ?? "—"}{category.capacity ? ` / ${category.capacity}` : ""}</span>
              <span data-label="Gross">{category.collection == null ? "—" : money.format(category.collection / 100)}</span>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

export default function App() {
  const [selectedDate, setSelectedDate] = useState(indiaToday());
  const [selectedVenue, setSelectedVenue] = useState("ALL");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      if (inDemoMode) {
        setData(demoDashboard(selectedDate, selectedVenue));
      } else {
        const query = new URLSearchParams({ date: selectedDate, venueCode: selectedVenue });
        const response = await fetch(`${API_BASE}/api/dashboard?${query}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Tracker API returned ${response.status}`);
        setData(await response.json());
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [selectedDate, selectedVenue]);
  useEffect(() => {
    if (inDemoMode) return undefined;
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [selectedDate, selectedVenue]);

  const currentShows = useMemo(() => data?.shows?.filter((show) => show.isCurrent) || [], [data]);
  const capturedShows = useMemo(() => currentShows.filter((show) => show.snapshot).length, [currentShows]);
  const selectedVenueName = data?.venue?.shortName || THEATRE_OPTIONS.find((venue) => venue.code === selectedVenue)?.shortName;
  const missedNote = `${data?.summary?.missedShows || 0} missed · ${data?.summary?.totalShows || 0} total`;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="./" aria-label="Madanapalle theatre tracker home">
          <span className="brand__mark">MD</span>
          <span><strong>Collection Desk</strong><small>Madanapalle</small></span>
        </a>
        <div className="live-indicator"><i /> Automatic backup + final capture</div>
      </header>

      <main>
        <section className="date-control" aria-label="Dashboard filters">
          <div className="control-field">
            <label htmlFor="theatre">Theatre</label>
            <select id="theatre" value={selectedVenue} onChange={(event) => setSelectedVenue(event.target.value)}>
              {THEATRE_OPTIONS.map((venue) => <option key={venue.code} value={venue.code}>{venue.shortName}</option>)}
            </select>
          </div>
          <div className="control-field">
            <label htmlFor="show-date">Show date</label>
            <input id="show-date" type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
          </div>
          <button type="button" onClick={load} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
        </section>

        {inDemoMode && <div className="notice notice--demo">Demo preview — these are illustrative numbers, not live BookMyShow data.</div>}
        {error && <div className="notice notice--error"><strong>Unable to load the tracker.</strong> {error} <button onClick={load}>Try again</button></div>}

        {data && (
          <>
            <section className="metrics" aria-label="Daily totals">
              <Metric label="Final tickets" value={number.format(data.summary.ticketsSold)} note={`${data.summary.finalizedShows} of ${data.summary.totalShows} shows finalized`} tone="ink" />
              <Metric label="Gross" value={money.format(data.summary.collectionPaise / 100)} note="₹5 MC adjusted per ticket" tone="red" />
              <Metric label="Final occupancy" value={`${data.summary.occupancyPercent}%`} note={`${number.format(data.summary.capacity)} finalized seats`} />
              <Metric label="Shows captured" value={capturedShows} note={missedNote} />
            </section>

            <section className="section-heading">
              <div><p className="eyebrow">{selectedVenueName}</p><h1>{displayDate.format(new Date(`${selectedDate}T12:00:00+05:30`))}</h1></div>
              <p><span className="updated-dot" />Updated {dateTime.format(new Date(data.generatedAt))}</p>
            </section>

            <section className="show-list" aria-live="polite">
              {currentShows.length ? currentShows.map((show) => (
                <ShowCard key={show.id} show={show} />
              )) : (
                <div className="empty"><strong>No shows found for this date.</strong><span>Choose another date or refresh the dashboard.</span></div>
              )}
            </section>

            {data.scheduleChanges?.length > 0 && (
              <section className="changes">
                <p className="eyebrow">Schedule audit</p>
                <h2>Movie and show changes</h2>
                {data.scheduleChanges.map((change) => (
                  <div className="change-row" key={change.id}>
                    <span>{selectedVenue === "ALL" ? `${change.venueName} · ` : ""}{change.showTime || "Show"}</span>
                    <strong>{change.previousMovie || "Removed"} → {change.nextMovie || "No replacement"}</strong>
                    <time>{dateTime.format(new Date(change.observedAt))}</time>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </main>

      <footer className="site-footer">
        <span>Asia/Kolkata time · ₹5 MC adjusted per ticket</span>
        <span>Source: BookMyShow seat availability</span>
      </footer>
    </div>
  );
}
