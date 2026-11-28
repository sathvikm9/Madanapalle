import { useCallback, useEffect, useState } from "react";
import { FIRST_LIVE_DATE } from "./dateRange.js";

const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("en-IN");
const time = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
const TESTING_VENUES = Object.freeze([
  { code: "ALL", name: "All theatres" },
  { code: "RTDM", name: "Ravi" },
  { code: "ASRM", name: "ASR" },
  { code: "SKMD", name: "Sri Krishna" },
  { code: "MSDR", name: "Mini Siddartha" },
  { code: "SUTD", name: "Sunil" },
  { code: "SCM", name: "Sai Chitra" }
]);
const TESTING_VENUE_NAMES = Object.freeze(Object.fromEntries(TESTING_VENUES.map((venue) => [venue.code, venue.name])));

const DEMO = {
  enabled: true,
  mode: "bookmyshow-final-server-testing",
  refreshedAt: "2026-11-16T06:02:00.000Z",
  summary: { shows: 5, finalCaptured: 3, failed: 0, unavailable: 234, capacity: 1_601, estimatedCollectionPaise: 2_258_000, occupancyPercent: 14.62, exactMatches: 3 },
  discovery: [
    { venue_code: "RTDM", last_status: "succeeded", last_finished_at: "2026-11-16T05:02:00.000Z" },
    { venue_code: "SUTD", last_status: "succeeded", last_finished_at: "2026-11-16T05:03:00.000Z" }
  ],
  shows: [
    { id: "1", venueCode: "RTDM", venueName: "Ravi", movieTitle: "Vishwanath and Sons", showTime: "11:00 AM",
      initial: null,
      final: { sold: 103, capacity: 637, collectionPaise: 1_004_800, occupancyPercent: 16.17, capturedAt: "2026-11-16T05:44:04.000Z", categories: [] },
      preferred: { sold: 103, capacity: 637, collectionPaise: 1_004_800, occupancyPercent: 16.17 },
      collector: { sold: 103, capacity: 637, collectionPaise: 1_004_800, capturedAt: "2026-11-16T05:44:10.000Z" },
      comparison: { tickets: 0, collectionPaise: 0, exactTickets: true },
      jobs: { initial: { status: "not_scheduled", attempts: 0 }, final: { status: "succeeded", attempts: 1 } } },
    { id: "2", venueCode: "RTDM", venueName: "Ravi", movieTitle: "Vishwanath and Sons", showTime: "02:30 PM",
      initial: null, final: null, preferred: null, collector: null, comparison: null,
      jobs: { initial: { status: "not_scheduled", attempts: 0 }, final: { status: "pending", attempts: 0, dueAt: "2026-11-16T09:14:00.000Z" } } },
    { id: "3", venueCode: "SUTD", venueName: "Sunil", movieTitle: "Vishwanath and Sons", showTime: "11:00 AM",
      initial: null,
      final: { sold: 47, capacity: 327, collectionPaise: 453_200, occupancyPercent: 14.37, capturedAt: "2026-11-16T05:39:04.000Z", categories: [] },
      preferred: { sold: 47, capacity: 327, collectionPaise: 453_200, occupancyPercent: 14.37 },
      collector: { sold: 47, capacity: 327, collectionPaise: 453_200, capturedAt: "2026-11-16T05:39:10.000Z" },
      comparison: { tickets: 0, collectionPaise: 0, exactTickets: true },
      jobs: { initial: { status: "not_scheduled", attempts: 0 }, final: { status: "succeeded", attempts: 1 } } }
  ]
};

function Job({ label, job, snapshot }) {
  const status = snapshot ? "captured" : job?.status || "not_scheduled";
  const detail = snapshot?.capturedAt
    ? time.format(new Date(snapshot.capturedAt))
    : job?.lastError || (job?.dueAt ? `Due ${time.format(new Date(job.dueAt))}` : "Waiting for schedule");
  return <div className={`bms-job bms-job--${status}`}><i aria-hidden="true" /><span>{label}</span><strong>{status.replaceAll("_", " ")}</strong><small>{detail}</small></div>;
}

function ShowCard({ show }) {
  const snapshot = show.final || show.initial;
  const providerName = show.provider === "district" ? "District" : "BookMyShow";
  return (
    <article className="bms-test-show">
      <header className="bms-test-show__head">
        <div className="bms-test-show__identity">
          <div className="bms-test-show__meta"><time>{show.showTime}</time><span>{show.venueName}</span><em>{providerName}</em></div>
          <h3>{show.movieTitle}</h3>
        </div>
        <span className={`bms-test-difference ${show.comparison?.exactTickets ? "is-match" : "bms-test-difference--muted"}`}>
          {show.comparison?.exactTickets ? "✓ Exact collector match" : show.comparison ? `Difference ${show.comparison.tickets}` : "Awaiting comparison"}
        </span>
      </header>
      <div className="bms-test-show__comparison">
        <div className="bms-test-value"><span>Server unavailable</span><strong>{snapshot ? number.format(snapshot.sold) : "—"}</strong><b>{snapshot ? `${money.format(snapshot.collectionPaise / 100)} estimated` : "Awaiting cutoff"}</b><small>{snapshot ? `${snapshot.occupancyPercent || Math.round((snapshot.sold / snapshot.capacity) * 10_000) / 100}% of ${number.format(snapshot.capacity)} seats` : "No server capture yet"}</small></div>
        <div className="bms-test-value"><span>Extension collector</span><strong>{show.collector ? number.format(show.collector.sold) : "—"}</strong><b>{show.collector ? money.format(show.collector.collectionPaise / 100) : "No comparison yet"}</b><small>{show.collector ? `Captured ${time.format(new Date(show.collector.capturedAt))}` : "Production data stays separate"}</small></div>
      </div>
      <div className="bms-test-jobs bms-test-jobs--single"><Job label="Final cutoff read" job={show.jobs.final} snapshot={show.final} /></div>
    </article>
  );
}

export default function BmsTestingView({ apiBase, demo, maxDate }) {
  const [venueCode, setVenueCode] = useState("ALL");
  const [date, setDate] = useState(maxDate);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const discoveryIssues = (data?.discovery || []).filter((item) =>
    item.actionable === true && (venueCode === "ALL" || item.venue_code === venueCode)
  );

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      if (demo) { setData({ ...DEMO, date, venueCode }); return; }
      const response = await fetch(`${apiBase}/api/testing/bms-dashboard?date=${encodeURIComponent(date)}&venueCode=${encodeURIComponent(venueCode)}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || `Testing dashboard returned ${response.status}`);
      setData(payload);
    } catch (requestError) { setError(requestError.message); }
    finally { setLoading(false); }
  }, [apiBase, date, demo, venueCode]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const timer = window.setInterval(() => void load(), 60_000); return () => window.clearInterval(timer); }, [load]);

  return (
    <section className="bms-testing" aria-label="Automatic server collection testing">
      <header className="bms-testing__hero">
        <div><p className="eyebrow">Server collector laboratory</p><h1>Server Collection Test</h1><p>Final availability snapshots from five BookMyShow theatres and Sai Chitra on District.</p></div>
        <span><i aria-hidden="true" /> Isolated from production</span>
      </header>
      <div className="bms-testing__filters">
        <label><span>Theatre</span><select value={venueCode} onChange={(event) => setVenueCode(event.target.value)} aria-label="Testing theatre">{TESTING_VENUES.map((venue) => <option key={venue.code} value={venue.code}>{venue.name}</option>)}</select></label>
        <label><span>Show date</span><input type="date" min={FIRST_LIVE_DATE} max={maxDate} value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <button type="button" onClick={load} disabled={loading}><span aria-hidden="true">↻</span>{loading ? "Refreshing…" : "Refresh results"}</button>
        <div className="bms-testing__rules"><span>6 theatres</span><span>BMS + District</span><span>Separate testing tables</span><span>Final cutoff −1 min</span></div>
      </div>
      {error && <div className="bms-testing__message bms-testing__message--error" role="alert"><strong>Testing data could not load</strong><span>{error}</span></div>}
      {data && !data.enabled && <div className="bms-testing__empty"><strong>Server testing is not connected yet.</strong><span>Browser Rendering and the private layout key must be configured before jobs can run. Missing data will never be shown as zero.</span></div>}
      {data?.enabled && <div className="bms-testing__results">
        <header className="bms-testing__results-head"><div><p className="eyebrow">Capture overview · {date}</p><h2>{data.summary.shows} shows scheduled</h2><span>{data.refreshedAt ? `Updated ${time.format(new Date(data.refreshedAt))}` : "Waiting for the first scheduler cycle"}</span></div><div className="bms-testing__progress"><strong>{data.summary.finalCaptured}/{data.summary.shows}</strong><span>final captures</span></div></header>
        <div className="bms-testing__summary">
          <article className="bms-testing__metric bms-testing__metric--ink"><span>Shows scheduled</span><strong>{number.format(data.summary.shows)}</strong><small>{venueCode === "ALL" ? "Across all testing theatres" : TESTING_VENUE_NAMES[venueCode]}</small></article>
          <article className="bms-testing__metric bms-testing__metric--green"><span>Final captures</span><strong>{number.format(data.summary.finalCaptured)}</strong><small>{data.summary.shows ? `${Math.round((data.summary.finalCaptured / data.summary.shows) * 100)}% completed` : "Waiting for discovery"}</small></article>
          <article className="bms-testing__metric bms-testing__metric--slate"><span>Unavailable seats</span><strong>{data.summary.finalCaptured ? number.format(data.summary.unavailable ?? data.summary.tickets) : "—"}</strong><small>{data.summary.finalCaptured ? `${data.summary.occupancyPercent}% unavailable` : "No final reads yet"}</small></article>
          <article className={`bms-testing__metric ${data.summary.failed ? "bms-testing__metric--red" : "bms-testing__metric--cream"}`}><span>{data.summary.failed ? "Needs review" : "Estimated collection"}</span><strong>{data.summary.failed ? number.format(data.summary.failed) : (data.summary.finalCaptured ? money.format((data.summary.estimatedCollectionPaise ?? data.summary.collectionPaise) / 100) : "—")}</strong><small>{data.summary.failed ? "Open issues requiring review" : "₹5 MC adjusted per ticket"}</small></article>
        </div>
        {discoveryIssues.length > 0 && <section className="bms-testing__issues" aria-label="Discovery issues"><header><strong>Discovery needs attention</strong><span>{discoveryIssues.length} {discoveryIssues.length === 1 ? "theatre" : "theatres"}</span></header><div>{discoveryIssues.map((issue) => <article key={issue.venue_code} role="status"><strong>{TESTING_VENUE_NAMES[issue.venue_code] || issue.venue_code}</strong><span>{issue.last_error || "The server could not read the current provider schedule."}</span></article>)}</div></section>}
        {data.shows.length ? <div className="bms-testing__show-list">{data.shows.map((show) => <ShowCard key={show.id} show={show} />)}</div> : <div className="bms-testing__empty"><strong>No matching provider sessions are known for this date yet.</strong><span>The server keeps all six theatre schedules in isolated testing tables and records provider rejections without changing production data.</span></div>}
      </div>}
    </section>
  );
}
