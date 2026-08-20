import { useEffect, useMemo, useState } from "react";
import { demoDashboard } from "./demo.js";

const API_BASE = (import.meta.env.VITE_API_BASE || "http://localhost:8787").replace(/\/$/, "");
const inDemoMode = new URLSearchParams(window.location.search).get("demo") === "1";

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
  const netPrices = (show.snapshot?.categories || show.advertisedCategories || []).map((category) => ({
    name: category.name,
    list: category.listPricePaise,
    net: category.netPricePaise ?? Math.max(category.listPricePaise - 500, 0),
    sold: category.sold,
    capacity: category.capacity,
    collection: category.collectionPaise
  }));

  return (
    <article className={`show-card ${!show.isCurrent ? "show-card--history" : ""}`}>
      <div className="show-card__time">
        <span>{show.showTime}</span>
        <StatusPill status={show.status} />
      </div>
      <div className="show-card__movie">
        <h3>{show.movieTitle}</h3>
        <p>{[show.language, show.format].filter(Boolean).join(" · ")} <span>Session {show.sessionId}</span></p>
      </div>
      <div className="show-card__result">
        {show.snapshot ? (
          <>
            <div><strong>{number.format(show.snapshot.sold)}</strong><span>tickets</span></div>
            <div><strong>{money.format(show.snapshot.collectionPaise / 100)}</strong><span>net collection</span></div>
          </>
        ) : (
          <div className="pending-copy">
            <strong>Due {dateTime.format(new Date(show.captureDueAt))}</strong>
            <span>Capture during the final booking minute</span>
          </div>
        )}
      </div>
      <div className="show-card__meta">
        {show.snapshot ? (
          <span>Captured {dateTime.format(new Date(show.snapshot.capturedAt))} · {show.snapshot.occupancyPercent}% occupancy</span>
        ) : (
          <span>Booking cutoff {dateTime.format(new Date(show.cutoffAt))}</span>
        )}
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          {open ? "Hide breakdown" : "Price breakdown"}
        </button>
      </div>
      {open && (
        <div className="price-table" role="region" aria-label={`${show.showTime} price breakdown`}>
          <div className="price-table__head"><span>Class</span><span>Listed → counted</span><span>Sold</span><span>Collection</span></div>
          {netPrices.map((category) => (
            <div className="price-table__row" key={category.name}>
              <span>{category.name}</span>
              <span>{money.format(category.list / 100)} → {money.format(category.net / 100)}</span>
              <span>{category.sold ?? "—"}{category.capacity ? ` / ${category.capacity}` : ""}</span>
              <span>{category.collection == null ? "—" : money.format(category.collection / 100)}</span>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

export default function App() {
  const [selectedDate, setSelectedDate] = useState(indiaToday());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      if (inDemoMode) {
        setData(demoDashboard(selectedDate));
      } else {
        const response = await fetch(`${API_BASE}/api/dashboard?date=${selectedDate}&venueCode=SKMD`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Tracker API returned ${response.status}`);
        setData(await response.json());
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [selectedDate]);
  useEffect(() => {
    if (inDemoMode) return undefined;
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [selectedDate]);

  const currentShows = useMemo(() => data?.shows?.filter((show) => show.isCurrent) || [], [data]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="./" aria-label="Sri Krishna tracker home">
          <span className="brand__mark">SK</span>
          <span><strong>Collection Desk</strong><small>Madanapalle</small></span>
        </a>
        <div className="live-indicator"><i /> Automatic final capture</div>
      </header>

      <main>
        <section className="hero">
          <div>
            <p className="eyebrow">Sri Krishna · SKMD</p>
            <h1>Every show, closed with a final count.</h1>
            <p className="hero__copy">Tickets and theatre collection captured in the last minute before BookMyShow closes. Every listed ticket price is counted after subtracting ₹5.</p>
          </div>
          <div className="date-control">
            <label htmlFor="show-date">Show date</label>
            <input id="show-date" type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
            <button type="button" onClick={load} disabled={loading}>{loading ? "Refreshing…" : "Refresh now"}</button>
          </div>
        </section>

        {inDemoMode && <div className="notice notice--demo">Demo preview — these are illustrative numbers, not live BookMyShow data.</div>}
        {error && <div className="notice notice--error"><strong>Unable to load the tracker.</strong> {error} <button onClick={load}>Try again</button></div>}

        {data && (
          <>
            <section className="metrics" aria-label="Daily totals">
              <Metric label="Final tickets" value={number.format(data.summary.ticketsSold)} note={`${data.summary.finalizedShows} of ${data.summary.totalShows} shows finalized`} tone="ink" />
              <Metric label="Net collection" value={money.format(data.summary.collectionPaise / 100)} note="₹5 removed per sold ticket" tone="red" />
              <Metric label="Final occupancy" value={`${data.summary.occupancyPercent}%`} note={`${number.format(data.summary.capacity)} finalized seats`} />
              <Metric label="Still pending" value={data.summary.pendingShows} note={data.summary.missedShows ? `${data.summary.missedShows} capture missed` : "Collector is watching"} />
            </section>

            <section className="section-heading">
              <div><p className="eyebrow">Show ledger</p><h2>{selectedDate}</h2></div>
              <p>Updated {dateTime.format(new Date(data.generatedAt))}</p>
            </section>

            <section className="show-list" aria-live="polite">
              {currentShows.length ? currentShows.map((show) => <ShowCard key={show.id} show={show} />) : (
                <div className="empty"><strong>No shows discovered for this date.</strong><span>The collector checks today and tomorrow automatically.</span></div>
              )}
            </section>

            {data.scheduleChanges?.length > 0 && (
              <section className="changes">
                <p className="eyebrow">Schedule audit</p>
                <h2>Movie and show changes</h2>
                {data.scheduleChanges.map((change) => (
                  <div className="change-row" key={change.id}>
                    <span>{change.showTime || "Show"}</span>
                    <strong>{change.previousMovie || "Removed"} → {change.nextMovie || "No replacement"}</strong>
                    <time>{dateTime.format(new Date(change.observedAt))}</time>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </main>

      <footer>
        <span>Asia/Kolkata time · ₹5 net adjustment per ticket</span>
        <span>Source: BookMyShow seat availability</span>
      </footer>
    </div>
  );
}
