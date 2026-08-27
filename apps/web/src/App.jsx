import { useEffect, useMemo, useState } from "react";
import { demoDashboard } from "./demo.js";
import { groupShowsByMovie, sortMovieGroups } from "./movieGroups.js";
import { buildMoviesCopyText, buildShowsCopyText } from "./copyData.js";

const API_BASE = (import.meta.env.VITE_API_BASE || "http://localhost:8787").replace(/\/$/, "");
const pageParams = new URLSearchParams(window.location.search);
const inDemoMode = pageParams.get("demo") === "1";
const installRequested = pageParams.get("install") === "1";
const installPreview = import.meta.env.DEV ? pageParams.get("installPreview") : "";
const INSTALL_DISMISSED_KEY = "mpltalkies-install-dismissed-at";
const INSTALL_DISMISS_MS = 30 * 24 * 60 * 60 * 1000;
const THEATRE_OPTIONS = [
  { code: "ALL", shortName: "All theatres" },
  { code: "SKMD", shortName: "Sri Krishna" },
  { code: "SCM", shortName: "Sai Chitra" },
  { code: "RTDM", shortName: "Ravi" },
  { code: "ASRM", shortName: "ASR" }
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

function DashboardSkeleton() {
  return (
    <section className="dashboard-skeleton" aria-label="Loading daily theatre data" aria-live="polite">
      <span className="sr-only">Loading daily theatre data…</span>
      <div className="dashboard-skeleton__metrics" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => <i key={index} />)}
      </div>
      <div className="dashboard-skeleton__heading" aria-hidden="true"><i /><i /></div>
      <div className="dashboard-skeleton__cards" aria-hidden="true">
        {Array.from({ length: 3 }, (_, index) => <i key={index} />)}
      </div>
    </section>
  );
}

function isIosDevice() {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent)
    || (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1);
}

function isMobileDevice() {
  return /android|iphone|ipad|ipod/i.test(window.navigator.userAgent) || isIosDevice();
}

function isStandaloneApp() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function installPromptWasDismissed() {
  try {
    const dismissedAt = Number(window.localStorage.getItem(INSTALL_DISMISSED_KEY));
    return Number.isFinite(dismissedAt) && Date.now() - dismissedAt < INSTALL_DISMISS_MS;
  } catch {
    return false;
  }
}

function InstallCard({ installPrompt, onInstalled, previewPlatform, requested = false }) {
  const ios = previewPlatform === "ios" || isIosDevice();
  const [showSteps, setShowSteps] = useState(() => requested && ios);

  async function install() {
    if (!installPrompt) {
      setShowSteps((visible) => !visible);
      return;
    }

    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    onInstalled(choice.outcome !== "accepted");
  }

  return (
    <aside className={`install-card${requested ? " install-card--requested" : ""}`} aria-label="Install MPLTalkies">
      <div className="install-card__icon" aria-hidden="true">MPL</div>
      <div className="install-card__copy">
        <strong>{requested ? "Install MPLTalkies" : "Add MPLTalkies to your home screen"}</strong>
        <span>Open the live collection desk in one tap.</span>
      </div>
      <button className="install-card__action" type="button" onClick={install}>
        {installPrompt ? "Install" : showSteps ? "Hide steps" : "Show steps"}
      </button>
      <button className="install-card__dismiss" type="button" onClick={() => onInstalled(true)} aria-label="Dismiss install suggestion">×</button>

      {showSteps && (
        <div className="install-card__steps" role="status">
          {ios ? (
            <ol>
              <li>Open this page in <strong>Safari</strong>.</li>
              <li>Tap the <strong>Share</strong> button.</li>
              <li>Choose <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.</li>
            </ol>
          ) : (
            <ol>
              <li>If this opened inside WhatsApp or Instagram, choose <strong>Open in Chrome</strong> from its menu.</li>
              <li>In Chrome, open the menu <strong>⋮</strong>.</li>
              <li>Choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li>
            </ol>
          )}
          <button type="button" onClick={() => setShowSteps(false)}>Got it</button>
        </div>
      )}
    </aside>
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

function MovieCard({ movie }) {
  const [open, setOpen] = useState(false);
  const complete = movie.finalizedShows === movie.shows.length;
  const progressLabel = complete ? "Complete" : movie.missedShows ? "Partial" : "In progress";
  const progressTone = complete ? "complete" : movie.missedShows ? "attention" : "progress";

  return (
    <article className="movie-card">
      <div className="movie-card__main">
        <div className="movie-card__title">
          <div className="movie-card__title-row">
            <span className={`movie-progress movie-progress--${progressTone}`}>{progressLabel}</span>
            <span className="movie-card__count">{movie.capturedShows} of {movie.shows.length} shows captured</span>
          </div>
          <h3>{movie.movieTitle}</h3>
          <p>{[movie.language, movie.format].filter(Boolean).join(" · ") || "Details unavailable"}</p>
          <div
            className={`movie-card__badges${movie.missedShows || movie.pendingShows ? " has-exceptions" : ""}`}
            aria-label="Movie capture status"
          >
            {movie.finalizedShows > 0 && <span className="is-final">{movie.finalizedShows} final</span>}
            {movie.missedShows > 0 && <span className="is-missed">{movie.missedShows} missed</span>}
            {movie.pendingShows > 0 && <span className="is-pending">{movie.pendingShows} pending</span>}
          </div>
        </div>

        <div className="movie-card__totals">
          <div><span>Tickets</span><strong>{number.format(movie.ticketsSold)}</strong></div>
          <div><span>Gross</span><strong>{money.format(movie.collectionPaise / 100)}</strong></div>
        </div>
      </div>

      <footer className="movie-card__footer">
        <span>
          {movie.capturedShows
            ? `${movie.occupancyPercent}% occupancy across ${number.format(movie.capacity)} captured seats`
            : "No capture available yet"}
        </span>
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          {open ? "Hide theatres" : "Theatre breakdown"}
        </button>
      </footer>

      {open && (
        <div className="movie-breakdown" role="region" aria-label={`${movie.movieTitle} theatre breakdown`}>
          <div className="movie-breakdown__head">
            <span>Theatre &amp; show</span><span>Tickets</span><span>Gross</span>
          </div>
          {movie.shows.map((show) => (
            <div className="movie-breakdown__row" key={show.id}>
              <div className="movie-breakdown__show">
                <strong>{show.venueShortName || show.venueName || show.venueCode}</strong>
                <time>{show.showTime}</time>
              </div>
              <span data-label="Tickets">{show.snapshot ? number.format(show.snapshot.sold) : "—"}</span>
              <strong data-label="Gross">{show.snapshot ? money.format(show.snapshot.collectionPaise / 100) : "—"}</strong>
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
  const [viewMode, setViewMode] = useState("shows");
  const [movieSort, setMovieSort] = useState("gross");
  const [copyStatus, setCopyStatus] = useState("idle");
  const [installPrompt, setInstallPrompt] = useState(null);
  const [showInstallCard, setShowInstallCard] = useState(
    () => !isStandaloneApp()
      && (installRequested || ((isMobileDevice() || Boolean(installPreview)) && !installPromptWasDismissed()))
  );

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
  useEffect(() => {
    function captureInstallPrompt(event) {
      event.preventDefault();
      setInstallPrompt(event);
      if (isMobileDevice() && !installPromptWasDismissed()) setShowInstallCard(true);
    }

    function markInstalled() {
      setInstallPrompt(null);
      setShowInstallCard(false);
      try {
        window.localStorage.removeItem(INSTALL_DISMISSED_KEY);
      } catch {
        // Installed state is still reflected in memory when storage is unavailable.
      }
    }

    window.addEventListener("beforeinstallprompt", captureInstallPrompt);
    window.addEventListener("appinstalled", markInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", captureInstallPrompt);
      window.removeEventListener("appinstalled", markInstalled);
    };
  }, []);

  function closeInstallCard(dismissed = false) {
    try {
      if (dismissed) window.localStorage.setItem(INSTALL_DISMISSED_KEY, String(Date.now()));
      else window.localStorage.removeItem(INSTALL_DISMISSED_KEY);
    } catch {
      // Installation must continue to work when browser storage is unavailable.
    }
    setInstallPrompt(null);
    setShowInstallCard(false);
  }

  async function copyData() {
    const text = viewMode === "movies"
      ? buildMoviesCopyText({ date: selectedDate, theatre: selectedVenueName, movies: movieGroups })
      : buildShowsCopyText({
          date: selectedDate,
          theatre: selectedVenueName,
          shows: currentShows,
          allTheatres: selectedVenue === "ALL"
        });

    try {
      if (window.navigator.clipboard?.writeText) {
        await window.navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        textarea.remove();
        if (!copied) throw new Error("Clipboard copy was rejected");
      }
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }

    window.setTimeout(() => setCopyStatus("idle"), 2200);
  }

  const currentShows = useMemo(() => data?.shows?.filter((show) => show.isCurrent) || [], [data]);
  const movieGroups = useMemo(
    () => sortMovieGroups(groupShowsByMovie(currentShows), movieSort),
    [currentShows, movieSort]
  );
  const capturedShows = useMemo(() => currentShows.filter((show) => show.snapshot).length, [currentShows]);
  const selectedVenueName = data?.venue?.shortName || THEATRE_OPTIONS.find((venue) => venue.code === selectedVenue)?.shortName;
  const missedNote = `${data?.summary?.missedShows || 0} missed · ${data?.summary?.totalShows || 0} total`;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="./" aria-label="MPLTalkies home">
          <span className="brand__mark">MPL</span>
          <span><strong>MPLTalkies</strong><small>Collection Desk</small></span>
        </a>
        <div className="live-indicator"><i /> Automatic backup + final capture</div>
      </header>

      <main>
        {showInstallCard && installRequested && (
          <InstallCard
            installPrompt={installPrompt}
            onInstalled={closeInstallCard}
            previewPlatform={installPreview}
            requested
          />
        )}

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

        {showInstallCard && !installRequested && (
          <InstallCard installPrompt={installPrompt} onInstalled={closeInstallCard} previewPlatform={installPreview} />
        )}

        {inDemoMode && <div className="notice notice--demo">Demo preview — these are illustrative numbers, not live BookMyShow data.</div>}
        {error && <div className="notice notice--error"><strong>Unable to load the tracker.</strong> {error} <button onClick={load}>Try again</button></div>}
        {loading && !data && <DashboardSkeleton />}

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
              <div className="section-heading__actions">
                <button
                  className={`copy-data-button${copyStatus === "copied" ? " is-copied" : ""}`}
                  type="button"
                  onClick={copyData}
                  disabled={!currentShows.length}
                  aria-live="polite"
                >
                  {copyStatus === "copied" ? "Copied!" : copyStatus === "failed" ? "Try again" : "Copy Data"}
                </button>
                <p className="section-heading__updated"><span className="updated-dot" />Updated {dateTime.format(new Date(data.generatedAt))}</p>
              </div>
            </section>

            <section className="view-toolbar" aria-label="Results view options">
              <div className="view-switch" role="group" aria-label="View by">
                <span>View by</span>
                <button type="button" className={viewMode === "shows" ? "is-active" : ""} aria-pressed={viewMode === "shows"} onClick={() => setViewMode("shows")}>Shows</button>
                <button type="button" className={viewMode === "movies" ? "is-active" : ""} aria-pressed={viewMode === "movies"} onClick={() => setViewMode("movies")}>Movies</button>
              </div>
              {viewMode === "movies" && movieGroups.length > 1 && (
                <label className="movie-sort">
                  <span>Sort</span>
                  <select value={movieSort} onChange={(event) => setMovieSort(event.target.value)}>
                    <option value="gross">Highest gross</option>
                    <option value="tickets">Most tickets</option>
                    <option value="earliest">Earliest show</option>
                    <option value="name">Movie name</option>
                  </select>
                </label>
              )}
            </section>

            <section className={viewMode === "movies" ? "movie-list" : "show-list"} aria-live="polite">
              {currentShows.length ? (
                viewMode === "movies"
                  ? movieGroups.map((movie) => <MovieCard key={movie.key} movie={movie} />)
                  : currentShows.map((show) => <ShowCard key={show.id} show={show} />)
              ) : (
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
        <span>Source: BookMyShow &amp; TicketNew seat availability</span>
      </footer>
    </div>
  );
}
