import { useCallback, useEffect, useMemo, useState } from "react";
import { FIRST_LIVE_DATE } from "./dateRange.js";

const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("en-IN");
const time = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });

const DEMO = {
  enabled: true,
  mode: "automatic-server-testing",
  refreshedAt: "2026-11-16T06:02:00.000Z",
  summary: { shows: 4, initialCaptured: 3, finalCaptured: 2, failed: 0, tickets: 187, capacity: 1_314, collectionPaise: 1_804_800, occupancyPercent: 14.23, exactMatches: 2 },
  discovery: [{ venue_code: "SKMD", last_status: "succeeded", last_finished_at: "2026-11-16T05:02:00.000Z" }],
  shows: [
    { id: "1", venueCode: "SKMD", venueName: "Sri Krishna", movieTitle: "Vishwanath and Sons", showTime: "11:00 AM",
      initial: { sold: 91, capacity: 657, collectionPaise: 884_100, capturedAt: "2026-11-16T05:40:06.000Z" },
      final: { sold: 103, capacity: 657, collectionPaise: 1_004_800, occupancyPercent: 15.68, capturedAt: "2026-11-16T05:44:04.000Z", categories: [] },
      preferred: { sold: 103, capacity: 657, collectionPaise: 1_004_800, occupancyPercent: 15.68 },
      collector: { sold: 103, capacity: 657, collectionPaise: 1_004_800, capturedAt: "2026-11-16T05:44:10.000Z" },
      comparison: { tickets: 0, collectionPaise: 0, exactTickets: true },
      jobs: { initial: { status: "succeeded", attempts: 1 }, final: { status: "succeeded", attempts: 1 } } },
    { id: "2", venueCode: "SKMD", venueName: "Sri Krishna", movieTitle: "Vishwanath and Sons", showTime: "02:10 PM",
      initial: { sold: 78, capacity: 657, collectionPaise: 753_600, capturedAt: "2026-11-16T08:50:03.000Z" }, final: null,
      preferred: { sold: 78, capacity: 657, collectionPaise: 753_600, occupancyPercent: 11.87 }, collector: null, comparison: null,
      jobs: { initial: { status: "succeeded", attempts: 1 }, final: { status: "pending", attempts: 0, dueAt: "2026-11-16T08:54:00.000Z" } } }
  ]
};

function Job({ label, job, snapshot }) {
  const status = snapshot ? "captured" : job?.status || "not_scheduled";
  const detail = snapshot?.capturedAt
    ? time.format(new Date(snapshot.capturedAt))
    : job?.lastError || (job?.dueAt ? `Due ${time.format(new Date(job.dueAt))}` : "Waiting for schedule");
  return <div className={`bms-job bms-job--${status}`}><span>{label}</span><strong>{status.replaceAll("_", " ")}</strong><small>{detail}</small></div>;
}

function ShowCard({ show }) {
  const snapshot = show.final || show.initial;
  return (
    <article className="bms-test-show">
      <header>
        <div><time>{show.showTime}</time><h3>{show.movieTitle}</h3><small>{show.venueName}</small></div>
        <span className={`bms-test-difference ${show.comparison?.exactTickets ? "is-match" : "bms-test-difference--muted"}`}>
          {show.comparison?.exactTickets ? "✓ Exact collector match" : show.comparison ? `Difference ${show.comparison.tickets}` : "Awaiting comparison"}
        </span>
      </header>
      <div className="bms-test-show__comparison">
        <div className="bms-test-value"><span>Server BMS test</span><strong>{snapshot ? number.format(snapshot.sold) : "—"}</strong><b>{snapshot ? money.format(snapshot.collectionPaise / 100) : "—"}</b><small>{snapshot ? `${snapshot.occupancyPercent || Math.round((snapshot.sold / snapshot.capacity) * 10_000) / 100}% occupied` : "No capture yet"}</small></div>
        <div className="bms-test-value"><span>Extension collector</span><strong>{show.collector ? number.format(show.collector.sold) : "—"}</strong><b>{show.collector ? money.format(show.collector.collectionPaise / 100) : "—"}</b><small>{show.collector ? `Captured ${time.format(new Date(show.collector.capturedAt))}` : "No collector snapshot"}</small></div>
      </div>
      <div className="bms-test-jobs"><Job label="Initial" job={show.jobs.initial} snapshot={show.initial} /><Job label="Final" job={show.jobs.final} snapshot={show.final} /></div>
    </article>
  );
}

export default function BmsTestingView({ apiBase, demo, maxDate, theatres }) {
  const options = useMemo(() => theatres.filter((item) => item.code === "ALL" || ["SKMD", "RTDM", "ASRM", "MSDR"].includes(item.code)), [theatres]);
  const [venueCode, setVenueCode] = useState("ALL");
  const [date, setDate] = useState(maxDate);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
    <section className="bms-testing" aria-label="Automatic BMS server testing">
      <header className="bms-testing__hero">
        <div><p className="eyebrow">Isolated experiment</p><h1>BMS Server Testing</h1></div>
        <span>Does not alter production</span>
      </header>
      <div className="bms-testing__filters">
        <label><span>Theatre</span><select value={venueCode} onChange={(event) => setVenueCode(event.target.value)}>{options.map((item) => <option key={item.code} value={item.code}>{item.shortName}</option>)}</select></label>
        <label><span>Show date</span><input type="date" min={FIRST_LIVE_DATE} max={maxDate} value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <button type="button" onClick={load} disabled={loading}>{loading ? "Refreshing…" : "Refresh results"}</button>
        <div className="bms-testing__rules"><span>Cloudflare scheduled</span><span>Separate tables</span><span>Bounded retries</span><span>Stops on rate limits</span></div>
      </div>
      {error && <div className="bms-testing__message bms-testing__message--error" role="alert"><strong>Testing data could not load</strong><span>{error}</span></div>}
      {data && !data.enabled && <div className="bms-testing__empty"><strong>Server testing is not active yet.</strong><span>The required BMS layout key has not been configured on the server, so no API capture will run or show false data.</span></div>}
      {data?.enabled && <div className="bms-testing__results">
        <header><div><p className="eyebrow">Automatic server results · {date}</p><h2>{data.summary.shows} BMS shows scheduled</h2><span>{data.refreshedAt ? `Updated ${time.format(new Date(data.refreshedAt))}` : "Waiting for the first scheduler cycle"}</span></div>
          <dl><div><dt>Final captures</dt><dd>{data.summary.finalCaptured}</dd></div><div><dt>Tickets</dt><dd>{number.format(data.summary.tickets)}</dd></div><div><dt>Collection</dt><dd>{money.format(data.summary.collectionPaise / 100)}</dd></div><div><dt>Needs review</dt><dd>{data.summary.failed}</dd></div></dl>
        </header>
        {data.shows.length ? <div className="bms-testing__show-list">{data.shows.map((show) => <ShowCard key={show.id} show={show} />)}</div> : <div className="bms-testing__empty"><strong>No BMS sessions are known for this date yet.</strong><span>The scheduler first mirrors sessions already synced to MPLTalkies; any direct BMS discovery rejection is recorded without bypassing it.</span></div>}
      </div>}
    </section>
  );
}
