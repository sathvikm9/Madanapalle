import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildMovieDailyTrend,
  buildReportModel,
  completedReportEndDate,
  movieMatchesSearch,
  movieReportRange,
  orderMoviesForPicker,
  previousReportDate,
  reportSummaryQuery,
  screenedDaysLabel,
  sortMoviesByGross,
  trackedReportDays
} from "./reports.js";

const number = new Intl.NumberFormat("en-IN");
const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const MOVIE_REPORT_SELECTION_KEY = "mpltalkies-movie-report-selection";
const MOVIE_REPORT_SECTION_KEY = "mpltalkies-movie-report-section";
const reportDate = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
  year: "numeric"
});
const DEMO_MOVIES = [
  {
    title: "The Paradise",
    firstTrackedDate: "2026-09-23",
    firstTrackedStartAt: "2026-09-23T16:15:00.000Z",
    lastTrackedDate: "2026-10-05",
    premiereDate: "2026-09-23",
    dayOneDate: "2026-09-24",
    officialReleaseDate: "2026-09-24",
    releaseDateSource: "bookmyshow",
    ticketsSold: 57_476,
    collectionPaise: 66_599_109
  },
  {
    title: "Irumudi",
    firstTrackedDate: "2026-08-21",
    firstTrackedStartAt: "2026-08-21T05:30:00.000Z",
    lastTrackedDate: "2026-10-05",
    premiereDate: null,
    dayOneDate: "2026-08-21",
    officialReleaseDate: "2026-08-21",
    releaseDateSource: "bookmyshow",
    ticketsSold: 48_768,
    collectionPaise: 46_309_530
  },
  { title: "Mandaadi", firstTrackedDate: "2026-09-18", firstTrackedStartAt: "2026-09-18T05:30:00.000Z", lastTrackedDate: "2026-10-05", dayOneDate: "2026-09-18", ticketsSold: 20_075, collectionPaise: 24_127_044 },
  { title: "Avengers Endgame: Encore", firstTrackedDate: "2026-09-25", firstTrackedStartAt: "2026-09-25T12:30:00.000Z", lastTrackedDate: "2026-10-04", dayOneDate: "2026-09-25", officialReleaseDate: "2026-09-25", releaseDateSource: "bookmyshow", ticketsSold: 10_288, collectionPaise: 12_437_081 },
  { title: "Don't Trouble the Trouble", firstTrackedDate: "2026-10-02", firstTrackedStartAt: "2026-10-02T05:30:00.000Z", lastTrackedDate: "2026-10-05", dayOneDate: "2026-10-02", officialReleaseDate: "2026-10-02", releaseDateSource: "district", ticketsSold: 6_049, collectionPaise: 7_071_310 },
  { title: "Vishwanath and Sons", firstTrackedDate: "2026-09-02", firstTrackedStartAt: "2026-09-02T05:30:00.000Z", lastTrackedDate: "2026-10-01", dayOneDate: "2026-09-02", ticketsSold: 4_720, collectionPaise: 5_114_208 }
];

function displayReportDate(value) {
  return reportDate.format(new Date(`${value}T12:00:00+05:30`));
}

function storedPreference(key, fallback = "") {
  try {
    return window.localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function savePreference(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private browsing and storage restrictions should not block report viewing.
  }
}

function moviePickerStatus(movie, maxDate) {
  if (movie?.isReRelease) return "Re-release";
  return movie?.lastTrackedDate && movie.lastTrackedDate >= maxDate ? "Running" : "Completed";
}

function HighlightedMovieTitle({ query, title }) {
  const wanted = query.trim();
  if (!wanted) return title;
  const index = title.toLocaleLowerCase("en-IN").indexOf(wanted.toLocaleLowerCase("en-IN"));
  if (index < 0) return title;
  return <>{title.slice(0, index)}<mark>{title.slice(index, index + wanted.length)}</mark>{title.slice(index + wanted.length)}</>;
}

function datesBetween(startDate, endDate) {
  const dates = [];
  const cursor = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function distributedTrend(total, count) {
  if (!count) return [];
  const target = Math.max(0, Math.round(Number(total || 0)));
  const weights = Array.from({ length: count }, (_, index) => Math.pow(count - index, .72));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const exact = weights.map((weight) => target * weight / weightTotal);
  const result = exact.map(Math.floor);
  let remaining = target - result.reduce((sum, value) => sum + value, 0);
  exact
    .map((value, index) => ({ index, fraction: value - result[index] }))
    .sort((left, right) => right.fraction - left.fraction)
    .forEach(({ index }) => {
      if (remaining <= 0) return;
      result[index] += 1;
      remaining -= 1;
    });
  return result;
}

function AnimatedDisclosure({ buttonClassName, children, contentClassName, contentLabel, label, openLabel }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={`animated-disclosure${open ? " is-open" : ""}`}>
      <button
        type="button"
        className={buttonClassName}
        aria-expanded={open}
        aria-label={open ? `Collapse ${openLabel || label}` : `Expand ${openLabel || label}`}
        onClick={() => setOpen((current) => !current)}
      >
        {label}
      </button>
      <div className="animated-disclosure__content" aria-hidden={!open}>
        <div className={`animated-disclosure__inner${contentClassName ? ` ${contentClassName}` : ""}`} aria-label={contentLabel}>
          {children}
        </div>
      </div>
    </div>
  );
}

function MovieReportSkeleton() {
  return (
    <section className="movie-report-skeleton" aria-label="Loading movie report" aria-live="polite">
      <span className="sr-only">Loading movie report…</span>
      <div className="movie-report-skeleton__identity" aria-hidden="true"><i /><i /></div>
      <div className="movie-report-skeleton__totals" aria-hidden="true"><i /><i /></div>
      <div className="movie-report-skeleton__days" aria-hidden="true">
        <b />
        {Array.from({ length: 5 }, (_, index) => <i key={index} />)}
      </div>
    </section>
  );
}

function scaledDemoMovie(movie, ratio) {
  return {
    ...movie,
    screenedShows: Math.round(movie.screenedShows * ratio),
    capturedShows: Math.round(movie.capturedShows * ratio),
    housefullShows: Math.round(movie.housefullShows * ratio),
    ticketsSold: Math.round(movie.ticketsSold * ratio),
    capacity: Math.round(movie.capacity * ratio),
    collectionPaise: Math.round(movie.collectionPaise * ratio)
  };
}

function demoSummaries(startDate, endDate, selectedCodes, theatres, movieTitle = "ALL") {
  const samples = {
    SKMD: ["Sri Krishna", 185, 50_124, 63_450_950],
    SCM: ["Sai Chitra", 188, 52_710, 50_512_980],
    RTDM: ["Ravi", 181, 46_832, 59_108_700],
    ASRM: ["ASR", 176, 41_905, 48_932_400]
  };
  const ratios = [.3, .23, .17, .12, .1, .08];

  return selectedCodes.map((code, venueIndex) => {
    const [name, shows, tickets, gross] = samples[code] || [theatres.find((item) => item.code === code)?.shortName || code, 0, 0, 0];
    const venueMovies = DEMO_MOVIES.map(({ title }, movieIndex) => {
      const ratio = ratios[movieIndex];
      return {
        title,
        screenedShows: Math.round(shows * ratio),
        capturedShows: Math.round(shows * ratio),
        housefullShows: movieIndex === 0 ? 7 - venueIndex : 2,
        ticketsSold: Math.round(tickets * ratio),
        capacity: Math.round(tickets * ratio * 1.45),
        collectionPaise: Math.round(gross * ratio)
      };
    });
    const allTotals = {
      screenedShows: shows,
      capturedShows: shows - (venueIndex === 3 ? 1 : 0),
      housefullShows: 9 - venueIndex,
      ticketsSold: tickets,
      capacity: Math.round(tickets * 1.45),
      collectionPaise: gross
    };
    const demoMovie = DEMO_MOVIES.find((movie) => movie.title === movieTitle);
    const fullRange = demoMovie ? movieReportRange(demoMovie, "full", demoMovie.lastTrackedDate) : null;
    const rangeRatio = fullRange
      ? Math.min(1, datesBetween(startDate, endDate).length / datesBetween(fullRange.startDate, fullRange.endDate).length)
      : 1;
    const selectedMovies = movieTitle === "ALL"
      ? venueMovies
      : venueMovies.filter((movie) => movie.title === movieTitle).map((movie) => scaledDemoMovie(movie, rangeRatio));
    const totals = movieTitle === "ALL"
      ? allTotals
      : selectedMovies[0] || {
          screenedShows: 0,
          capturedShows: 0,
          housefullShows: 0,
          ticketsSold: 0,
          capacity: 0,
          collectionPaise: 0
        };
    const reportDates = datesBetween(startDate, endDate);
    const dailyTotals = Object.fromEntries([
      "screenedShows",
      "capturedShows",
      "housefullShows",
      "ticketsSold",
      "capacity",
      "collectionPaise"
    ].map((key) => [key, distributedTrend(totals[key], reportDates.length)]));
    return {
      startDate,
      endDate,
      total: totals,
      venues: [{ code, name, movies: selectedMovies, ...totals }],
      days: reportDates.map((date, index) => ({
        date,
        screenedShows: dailyTotals.screenedShows[index],
        capturedShows: dailyTotals.capturedShows[index],
        housefullShows: dailyTotals.housefullShows[index],
        ticketsSold: dailyTotals.ticketsSold[index],
        capacity: dailyTotals.capacity[index],
        collectionPaise: dailyTotals.collectionPaise[index],
        venues: [{
          code,
          name,
          screenedShows: dailyTotals.screenedShows[index],
          capturedShows: dailyTotals.capturedShows[index],
          housefullShows: dailyTotals.housefullShows[index],
          ticketsSold: dailyTotals.ticketsSold[index],
          capacity: dailyTotals.capacity[index],
          collectionPaise: dailyTotals.collectionPaise[index]
        }]
      }))
    };
  });
}

function MovieCollectionTimeline({ days, closingGrossPaise = null }) {
  const finalDate = closingGrossPaise === null ? null : days.at(-1)?.date;

  return (
    <section className="report-panel report-panel--enter movie-daily" id="movie-report-day-wise" aria-label="Day-wise movie collection">
      <header className="report-panel__header"><h2>Day-wise collection</h2></header>
      <div className="movie-daily__body">
        <ol className="movie-daily__list">
          {days.map((day) => (
            <li key={day.date}>
              <AnimatedDisclosure
                buttonClassName="movie-daily__row"
                contentClassName="movie-daily__theatres"
                contentLabel={`${day.label} theatre-wise collection`}
                openLabel={`${day.label} theatre-wise collection`}
                label={<>
                  <span>
                    <strong>{day.label}</strong>
                    <time dateTime={day.date}>{displayReportDate(day.date)}</time>
                  </span>
                  <span className="movie-daily__amount">
                    <b>{money.format(day.collectionPaise / 100)}</b>
                    <i aria-hidden="true">⌄</i>
                  </span>
                </>}
              >
                {day.theatres.length ? day.theatres.map((theatre) => (
                  <div key={theatre.code}>
                    <strong>{theatre.name}</strong>
                    <span>{number.format(theatre.screenedShows)} {theatre.screenedShows === 1 ? "Show" : "Shows"}</span>
                    <b>{money.format(theatre.collectionPaise / 100)}</b>
                  </div>
                )) : (
                  <p>No shows screened</p>
                )}
              </AnimatedDisclosure>
              {day.weekNumber && day.date !== finalDate && (
                <div className="movie-daily__week">
                  <span>{day.weekNumber === 1 ? "1st week gross" : `${day.weekNumber} weeks gross`}</span>
                  <strong>{money.format(day.cumulativeCollectionPaise / 100)}</strong>
                </div>
              )}
            </li>
          ))}
        </ol>
        {closingGrossPaise !== null && (
          <div className="movie-daily__closing">
            <span>Total gross</span>
            <strong>{money.format(closingGrossPaise / 100)}</strong>
          </div>
        )}
      </div>
    </section>
  );
}

function MoviePicker({ loading, movies, selectedMovie, onSelect }) {
  const [query, setQuery] = useState(selectedMovie?.title || "");
  const [open, setOpen] = useState(false);
  const [filterActive, setFilterActive] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 640px)").matches);
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const pickerRef = useRef(null);
  const fieldRef = useRef(null);
  const sheetSearchRef = useRef(null);
  const dragStartRef = useRef(null);
  const orderedMovies = useMemo(() => orderMoviesForPicker(movies), [movies]);
  const filteredMovies = useMemo(() => {
    const wanted = filterActive ? query : "";
    return orderedMovies.filter((movie) => movieMatchesSearch(movie.title, wanted));
  }, [filterActive, orderedMovies, query]);
  const latestTrackedDate = useMemo(
    () => movies.reduce((latest, movie) => movie.lastTrackedDate > latest ? movie.lastTrackedDate : latest, ""),
    [movies]
  );

  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    setQuery(selectedMovie?.title || "");
    setFilterActive(false);
  }, [selectedMovie]);

  useEffect(() => {
    if (!open || filterActive) return;
    const selectedIndex = filteredMovies.findIndex((movie) => movie.title === selectedMovie?.title);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [filterActive, filteredMovies, open, selectedMovie]);

  useEffect(() => {
    if (!open) return undefined;
    function closeOutside(event) {
      if (!pickerRef.current?.contains(event.target)) setOpen(false);
    }
    function closeOnEscape(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    const previousOverflow = document.body.style.overflow;
    if (mobile) {
      document.body.style.overflow = "hidden";
      window.requestAnimationFrame(() => {
        sheetSearchRef.current?.focus({ preventScroll: true });
        sheetSearchRef.current?.select();
      });
    }
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
    };
  }, [mobile, open]);

  function openPicker() {
    setQuery(selectedMovie?.title || "");
    setFilterActive(false);
    setDragOffset(0);
    setOpen(true);
  }

  function closePicker() {
    setDragging(false);
    setDragOffset(0);
    setOpen(false);
  }

  function choose(movie) {
    setQuery(movie.title);
    setFilterActive(false);
    onSelect(movie);
    closePicker();
  }

  function updateQuery(value) {
    setQuery(value);
    setFilterActive(true);
    setActiveIndex(0);
    setOpen(true);
  }

  function handleSearchKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closePicker();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
    event.preventDefault();
    if (!open) {
      openPicker();
      return;
    }
    if (event.key === "Enter") {
      if (filteredMovies[activeIndex]) choose(filteredMovies[activeIndex]);
      return;
    }
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = (activeIndex + direction + filteredMovies.length) % Math.max(filteredMovies.length, 1);
    setActiveIndex(nextIndex);
    window.requestAnimationFrame(() => {
      document.querySelector(`[data-movie-index="${nextIndex}"]`)?.scrollIntoView({ block: "nearest" });
    });
  }

  function showAllMovies() {
    setQuery("");
    setFilterActive(false);
    setActiveIndex(0);
    window.requestAnimationFrame(() => {
      const target = mobile ? sheetSearchRef.current : fieldRef.current;
      target?.focus({ preventScroll: true });
    });
  }

  function startSheetDrag(event) {
    if (!mobile) return;
    dragStartRef.current = { pointerId: event.pointerId, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  }

  function moveSheet(event) {
    if (!dragStartRef.current || dragStartRef.current.pointerId !== event.pointerId) return;
    setDragOffset(Math.max(0, event.clientY - dragStartRef.current.y));
  }

  function finishSheetDrag(event) {
    if (!dragStartRef.current || dragStartRef.current.pointerId !== event.pointerId) return;
    const shouldClose = dragOffset > 72;
    dragStartRef.current = null;
    setDragging(false);
    if (shouldClose) closePicker();
    else setDragOffset(0);
  }

  const activeDescendant = open && filteredMovies[activeIndex] ? `report-movie-option-${activeIndex}` : undefined;

  return (
    <div className="movie-picker" ref={pickerRef}>
      <label htmlFor="report-movie-search"><span>Movie</span></label>
      <div className={`movie-picker__control${open ? " is-open" : ""}`}>
        <span className="movie-picker__search" aria-hidden="true" />
        <input
          ref={fieldRef}
          id="report-movie-search"
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="report-movie-options"
          aria-activedescendant={activeDescendant}
          aria-expanded={open}
          autoComplete="off"
          readOnly={mobile}
          placeholder={loading ? "Loading movies…" : "Search and select a movie"}
          value={query}
          onFocus={(event) => {
            openPicker();
            if (!mobile) event.currentTarget.select();
          }}
          onChange={(event) => updateQuery(event.target.value)}
          onKeyDown={handleSearchKey}
        />
        <button type="button" aria-label={open ? "Close movie list" : "Show all movies"} onClick={() => open ? closePicker() : openPicker()}>⌄</button>
      </div>
      {open && <button className="movie-picker__backdrop" type="button" aria-label="Close movie picker" onClick={closePicker} />}
      {open && (
        <div
          className={`movie-picker__menu${dragging ? " is-dragging" : ""}`}
          id="report-movie-options"
          role={mobile ? "dialog" : undefined}
          aria-modal={mobile ? "true" : undefined}
          aria-label="Choose a tracked movie"
          style={{ "--movie-sheet-drag": `${dragOffset}px` }}
        >
          <div
            className="movie-picker__sheet-handle"
            aria-hidden="true"
            onPointerDown={startSheetDrag}
            onPointerMove={moveSheet}
            onPointerUp={finishSheetDrag}
            onPointerCancel={finishSheetDrag}
          ><i /></div>
          <div className="movie-picker__sheet-header">
            <strong>Select movie</strong>
            <button type="button" aria-label="Close movie picker" onClick={closePicker}>×</button>
          </div>
          <div className="movie-picker__sheet-search">
            <span className="movie-picker__search" aria-hidden="true" />
            <input
              ref={sheetSearchRef}
              type="search"
              role="combobox"
              aria-label="Search tracked movies"
              aria-autocomplete="list"
              aria-controls="report-movie-list"
              aria-activedescendant={activeDescendant}
              aria-expanded="true"
              autoComplete="off"
              value={query}
              onChange={(event) => updateQuery(event.target.value)}
              onKeyDown={handleSearchKey}
            />
            {query && <button type="button" aria-label="Clear movie search" onClick={showAllMovies}>×</button>}
          </div>
          <p className="movie-picker__menu-note">{movies.length} tracked movies · Running first · Completed by gross</p>
          <div className="movie-picker__options" id="report-movie-list" role="listbox" aria-label="Tracked movies">
            {filteredMovies.length ? filteredMovies.map((movie, index) => {
              const selected = movie.title === selectedMovie?.title;
              const status = moviePickerStatus(movie, latestTrackedDate);
              return (
                <button
                  type="button"
                  role="option"
                  id={`report-movie-option-${index}`}
                  data-movie-index={index}
                  aria-selected={selected}
                  className={`${selected ? "is-selected" : ""}${index === activeIndex ? " is-active" : ""}`}
                  key={movie.title}
                  onPointerMove={() => setActiveIndex(index)}
                  onClick={() => choose(movie)}
                >
                  <span>
                    <strong><HighlightedMovieTitle title={movie.title} query={filterActive ? query : ""} /></strong>
                    <small>{money.format(Number(movie.collectionPaise || 0) / 100)} · {displayReportDate(movie.firstTrackedDate)} — {displayReportDate(movie.lastTrackedDate)}</small>
                  </span>
                  <span className="movie-picker__option-end">
                    <em className={`is-${status.toLocaleLowerCase("en-IN").replace(/[^a-z]+/g, "-")}`}>{status}</em>
                    <i aria-hidden="true">{selected ? "✓" : "→"}</i>
                  </span>
                </button>
              );
            }) : (
              <div className="movie-picker__empty">
                <strong>No movies found</strong>
                <span>Try another spelling or return to the complete collection list.</span>
                <button type="button" onClick={showAllMovies}>Show all movies</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ReportRow({ row, groupBy, allowDetails = true }) {
  const content = (
    <>
      <span className="report-result__name">
        <strong>{groupBy === "date" ? displayReportDate(row.label) : row.label}</strong>
        {row.capturedShows !== row.screenedShows && <small>{row.capturedShows} of {row.screenedShows} captured</small>}
      </span>
      <span data-label="Shows">{number.format(row.screenedShows)}</span>
      <span data-label="Tickets">{number.format(row.ticketsSold)}</span>
      <strong data-label="Gross">{money.format(row.collectionPaise / 100)}</strong>
    </>
  );

  if (!allowDetails || !row.details.length) return <div className="report-result__row">{content}</div>;
  return (
    <AnimatedDisclosure
      buttonClassName="report-result__row"
      contentClassName="report-result__details"
      openLabel={`${row.label} details`}
      label={<>{content}<i aria-hidden="true">⌄</i></>}
    >
      {row.details.map((detail) => (
        <div key={detail.key}>
          <span>{detail.label}</span>
          <span>{number.format(detail.screenedShows)} shows</span>
          <span>{number.format(detail.ticketsSold)} tickets</span>
          <strong>{money.format(detail.collectionPaise / 100)}</strong>
        </div>
      ))}
    </AnimatedDisclosure>
  );
}

export default function ReportsView({ apiBase, demo, initialVenue, maxDate, theatres }) {
  const reportTheatres = useMemo(() => theatres.filter((theatre) => theatre.code !== "ALL"), [theatres]);
  const allCodes = useMemo(() => reportTheatres.map((theatre) => theatre.code), [reportTheatres]);
  const demoMovies = useMemo(() => sortMoviesByGross(DEMO_MOVIES), []);
  const storedMovieTitle = useMemo(() => storedPreference(MOVIE_REPORT_SELECTION_KEY), []);
  const initialDemoMovie = demo ? demoMovies.find((movie) => movie.title === storedMovieTitle)
    || demoMovies.find((movie) => movie.title === "The Paradise")
    || demoMovies[0] : null;
  const theatreReportMaxDate = useMemo(() => previousReportDate(maxDate), [maxDate]);
  const [startDate, setStartDate] = useState("2026-08-21");
  const [endDate, setEndDate] = useState(() => previousReportDate(maxDate));
  const [selectedCodes, setSelectedCodes] = useState(() => initialVenue === "ALL" ? allCodes : [initialVenue]);
  const [reportType, setReportType] = useState("movie");
  const [movieOptions, setMovieOptions] = useState(() => demo ? demoMovies : []);
  const [movieCatalogLoading, setMovieCatalogLoading] = useState(false);
  const [movieCatalogError, setMovieCatalogError] = useState("");
  const [selectedMovie, setSelectedMovie] = useState(initialDemoMovie);
  const [movieReportSection, setMovieReportSection] = useState(() => storedPreference(MOVIE_REPORT_SECTION_KEY) === "theatre" ? "theatre" : "day");
  const [summaries, setSummaries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [appliedReport, setAppliedReport] = useState(null);
  const [showStickySummary, setShowStickySummary] = useState(false);
  const autoMovieReportRef = useRef("");
  const movieOverviewRef = useRef(null);
  const reportRequestRef = useRef(0);

  useEffect(() => {
    if (demo || movieOptions.length) return undefined;
    let cancelled = false;
    setMovieCatalogLoading(true);
    fetch(`${apiBase}/api/analytics/catalog`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`Movie catalogue returned ${response.status}`);
        return response.json();
      })
      .then((catalog) => {
        if (cancelled) return;
        const movies = sortMoviesByGross((catalog.movies || []).filter((movie) => movie?.title));
        const highestGrossingMovie = movies.find((movie) => movie.title === storedMovieTitle) || movies[0] || null;
        setMovieOptions(movies);
        setSelectedMovie(highestGrossingMovie);
        setMovieCatalogError("");
      })
      .catch(() => {
        if (!cancelled) setMovieCatalogError("Movie search is temporarily unavailable.");
      })
      .finally(() => {
        if (!cancelled) setMovieCatalogLoading(false);
      });
    return () => { cancelled = true; };
  }, [apiBase, demo, maxDate, movieOptions.length, storedMovieTitle]);

  const selectedMovieRange = useMemo(
    () => movieReportRange(selectedMovie, "full", maxDate),
    [maxDate, selectedMovie]
  );

  const runReport = useCallback(async () => {
    const reportCodes = reportType === "movie" ? allCodes : selectedCodes;
    const reportStartDate = reportType === "movie" ? selectedMovieRange?.startDate : startDate;
    const reportEndDate = reportType === "movie" ? selectedMovieRange?.endDate : endDate;
    if (!reportCodes.length) {
      setError("Select at least one theatre.");
      return;
    }
    if (!reportStartDate || !reportEndDate || reportStartDate > reportEndDate) {
      setError("Select a From date on or before the To date.");
      return;
    }
    if (reportType === "movie" && !selectedMovie?.title) {
      setError("Search and select a movie before generating its report.");
      return;
    }

    const requestId = ++reportRequestRef.current;
    setLoading(true);
    setError("");
    try {
      const movieTitle = reportType === "movie" ? selectedMovie.title : "ALL";
      let nextSummaries;
      if (demo) {
        nextSummaries = demoSummaries(reportStartDate, reportEndDate, reportCodes, reportTheatres, movieTitle);
      } else {
        const venueQueries = reportCodes.length === allCodes.length ? ["ALL"] : reportCodes;
        nextSummaries = await Promise.all(venueQueries.map(async (venueCode) => {
          const query = reportSummaryQuery({
            movieTitle,
            venueCode,
            startDate: reportStartDate,
            endDate: reportEndDate,
            completeDaysOnly: reportType === "movie"
          });
          const response = await fetch(`${apiBase}/api/analytics/summary?${query}`, { cache: "no-store" });
          if (!response.ok) throw new Error(`Reports API returned ${response.status}`);
          return response.json();
        }));
      }
      const includedEndDate = reportType === "movie"
        ? completedReportEndDate(nextSummaries, reportEndDate)
        : reportEndDate;
      if (requestId !== reportRequestRef.current) return;
      setSummaries(nextSummaries);
      setAppliedReport({
        startDate: reportStartDate,
        endDate: includedEndDate,
        reportType,
        movieTitle,
        movieView: reportType === "movie" ? "full" : null,
        movie: reportType === "movie" ? selectedMovie : null
      });
    } catch (requestError) {
      if (requestId === reportRequestRef.current) setError(requestError.message || "The report could not be generated.");
    } finally {
      if (requestId === reportRequestRef.current) setLoading(false);
    }
  }, [allCodes, apiBase, demo, endDate, reportTheatres, reportType, selectedCodes, selectedMovie, selectedMovieRange, startDate]);

  useEffect(() => {
    if (reportType !== "movie" || !selectedMovie?.title || !selectedMovieRange) return;
    const reportKey = `${selectedMovie.title}|full|${selectedMovieRange.startDate}|${selectedMovieRange.endDate}`;
    if (autoMovieReportRef.current === reportKey) return;
    autoMovieReportRef.current = reportKey;
    void runReport();
  }, [reportType, runReport, selectedMovie, selectedMovieRange]);

  const appliedSortBy = appliedReport?.reportType === "movie" ? "gross" : "tickets";
  const model = useMemo(() => buildReportModel(summaries, "theatre", appliedSortBy), [appliedSortBy, summaries]);
  const screenedDays = useMemo(() => trackedReportDays(summaries), [summaries]);
  const screenedDaysDisplay = screenedDaysLabel(screenedDays, Boolean(appliedReport?.movie?.premiereDate));
  const movieDailyTrend = useMemo(
    () => appliedReport?.reportType === "movie" ? buildMovieDailyTrend(summaries, appliedReport.movie, {
      startDate: appliedReport.startDate,
      endDate: appliedReport.endDate
    }) : [],
    [appliedReport, summaries]
  );
  const showClosingGross = appliedReport?.reportType === "movie"
    && appliedReport.movieView === "full"
    && appliedReport.movie?.lastTrackedDate
    && appliedReport.movie.lastTrackedDate < maxDate;
  const allSelected = selectedCodes.length === allCodes.length;

  useEffect(() => {
    const overview = movieOverviewRef.current;
    const mobile = window.matchMedia("(max-width: 640px)");
    if (!overview || appliedReport?.reportType !== "movie") {
      setShowStickySummary(false);
      return undefined;
    }

    let observer;
    const observe = () => {
      observer?.disconnect();
      setShowStickySummary(false);
      if (!mobile.matches) return;
      observer = new IntersectionObserver(([entry]) => {
        setShowStickySummary(!entry.isIntersecting && entry.boundingClientRect.bottom <= 64);
      }, { rootMargin: "-64px 0px 0px 0px", threshold: 0 });
      observer.observe(overview);
    };
    observe();
    mobile.addEventListener?.("change", observe);
    return () => {
      observer?.disconnect();
      mobile.removeEventListener?.("change", observe);
    };
  }, [appliedReport, summaries]);

  function chooseMovie(movie) {
    reportRequestRef.current += 1;
    savePreference(MOVIE_REPORT_SELECTION_KEY, movie.title);
    setSelectedMovie(movie);
    autoMovieReportRef.current = "";
    setLoading(false);
    setError("");
  }

  function changeReportType(nextType) {
    reportRequestRef.current += 1;
    setReportType(nextType);
    setSummaries([]);
    setAppliedReport(null);
    setError("");
    if (nextType === "movie") {
      autoMovieReportRef.current = "";
    } else {
      setStartDate("2026-08-21");
      setEndDate(theatreReportMaxDate);
    }
  }

  function changeMovieReportSection(nextSection, fromSticky = false) {
    savePreference(MOVIE_REPORT_SECTION_KEY, nextSection);
    setMovieReportSection(nextSection);
    if (!fromSticky) return;
    window.requestAnimationFrame(() => {
      const sectionSwitch = document.querySelector(".movie-report-sections:not(.movie-report-sticky__switch)");
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      sectionSwitch?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    });
  }

  function toggleTheatre(code) {
    setSelectedCodes((current) => current.includes(code)
      ? current.filter((item) => item !== code)
      : [...current, code]
    );
  }

  return (
    <section className="reports" aria-label="Movie reports">
      <form className={`report-filters${reportType === "movie" ? " report-filters--movie" : ""}`} onSubmit={(event) => { event.preventDefault(); void runReport(); }}>
        <div className="report-kind" aria-label="Report type">
          <button type="button" className={reportType === "movie" ? "is-active" : ""} aria-pressed={reportType === "movie"} onClick={() => changeReportType("movie")}>
            Movie report
          </button>
          <button type="button" className={reportType === "all" ? "is-active" : ""} aria-pressed={reportType === "all"} onClick={() => changeReportType("all")}>
            Theatre Report
          </button>
        </div>

        {reportType === "movie" && <div className="report-filters__scope report-filters__scope--movie">
          <MoviePicker
            loading={movieCatalogLoading}
            movies={movieOptions}
            selectedMovie={selectedMovie}
            onSelect={chooseMovie}
          />
          {movieCatalogError && <small className="movie-picker__error">{movieCatalogError}</small>}
        </div>}

        {reportType === "all" && (
          <>
            <div className="report-filters__dates">
              <label><span>From</span><input type="date" min="2026-08-21" max={endDate || theatreReportMaxDate} value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
              <label><span>To</span><input type="date" min={startDate || "2026-08-21"} max={theatreReportMaxDate} value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
            </div>

            <fieldset className="report-theatres">
              <legend>Theatres</legend>
              <label className="report-theatres__all">
                <input type="checkbox" aria-label="Select all theatres" checked={allSelected} onChange={() => setSelectedCodes(allSelected ? [] : allCodes)} />
                <span><strong>All theatres</strong><small>{selectedCodes.length} of {allCodes.length} selected</small></span>
              </label>
              <div>
                {reportTheatres.map((theatre) => (
                  <label key={theatre.code}>
                    <input type="checkbox" checked={selectedCodes.includes(theatre.code)} onChange={() => toggleTheatre(theatre.code)} />
                    <span>{theatre.shortName}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="report-filters__options">
              <button type="submit" disabled={loading || !selectedCodes.length || !startDate || !endDate}>{loading ? "Generating…" : "Generate theatre report"}</button>
            </div>
          </>
        )}
        {reportType === "movie" && loading && summaries.length > 0 && <p className="report-auto-status" role="status"><i aria-hidden="true" />Updating…</p>}
      </form>

      {error && <div className="report-error" role="alert">{error}</div>}

      {!error && reportType === "movie" && loading && summaries.length === 0 && <MovieReportSkeleton />}

      {!error && summaries.length > 0 && (
        <div className={`report-content${loading ? " is-updating" : ""}`} aria-busy={loading}>
          {appliedReport?.reportType === "movie" && (
            <section className="movie-report-identity" aria-label={`${appliedReport.movieTitle} run`}>
              <div>
                <p className="eyebrow">Movie report</p>
                <h2>{appliedReport.movieTitle}</h2>
                <p>{displayReportDate(appliedReport.startDate)} — {displayReportDate(appliedReport.endDate)}</p>
              </div>
            </section>
          )}

          {appliedReport?.reportType === "movie" ? (
            <section className="movie-report-overview" aria-label="Movie report totals" ref={movieOverviewRef}>
              <div className="movie-report-overview__facts">
                <div><span>Days screened</span><strong>{screenedDaysDisplay}</strong></div>
                <i aria-hidden="true" />
                <div><span>Shows screened</span><strong>{number.format(model.totals.screenedShows)}</strong><small>{number.format(model.totals.capturedShows)} captured</small></div>
              </div>
              <div className="movie-report-overview__totals">
                <div><span>Tickets sold</span><strong>{number.format(model.totals.ticketsSold)}</strong><small>{number.format(model.totals.housefullShows)} housefull</small></div>
                <div><span>Total collection</span><strong>{money.format(model.totals.collectionPaise / 100)}</strong><small>₹5 MC adjusted</small></div>
              </div>
            </section>
          ) : (
            <section className="report-summary" aria-label="Report totals">
              <div><span>Shows screened</span><strong>{number.format(model.totals.screenedShows)}</strong><small>{number.format(model.totals.capturedShows)} captured</small></div>
              <div><span>Tickets sold</span><strong>{number.format(model.totals.ticketsSold)}</strong><small>{number.format(model.totals.housefullShows)} housefull</small></div>
              <div><span>Total collection</span><strong>{money.format(model.totals.collectionPaise / 100)}</strong><small>₹5 MC adjusted</small></div>
            </section>
          )}

          {appliedReport?.reportType === "movie" && (
            <div className="movie-report-sections" role="group" aria-label="Movie report view">
              <button
                type="button"
                className={movieReportSection === "day" ? "is-active" : ""}
                aria-pressed={movieReportSection === "day"}
                aria-controls="movie-report-day-wise"
                onClick={() => changeMovieReportSection("day")}
              >
                Day Wise
              </button>
              <button
                type="button"
                className={movieReportSection === "theatre" ? "is-active" : ""}
                aria-pressed={movieReportSection === "theatre"}
                aria-controls="movie-report-theatre-wise"
                onClick={() => changeMovieReportSection("theatre")}
              >
                Theatre Wise
              </button>
            </div>
          )}

          {appliedReport?.reportType === "movie" && (
            <aside className={`movie-report-sticky${showStickySummary ? " is-visible" : ""}`} aria-hidden={!showStickySummary}>
              <div className="movie-report-sticky__summary">
                <strong>{appliedReport.movieTitle}</strong>
                <span>{number.format(model.totals.ticketsSold)} tickets <i>·</i> {money.format(model.totals.collectionPaise / 100)}</span>
              </div>
              <div className="movie-report-sections movie-report-sticky__switch" role="group" aria-label="Sticky movie report view">
                <button type="button" disabled={!showStickySummary} className={movieReportSection === "day" ? "is-active" : ""} aria-pressed={movieReportSection === "day"} onClick={() => changeMovieReportSection("day", true)}>Day Wise</button>
                <button type="button" disabled={!showStickySummary} className={movieReportSection === "theatre" ? "is-active" : ""} aria-pressed={movieReportSection === "theatre"} onClick={() => changeMovieReportSection("theatre", true)}>Theatre Wise</button>
              </div>
            </aside>
          )}

          {appliedReport?.reportType === "movie" && movieReportSection === "day" && movieDailyTrend.length > 0 && (
            <MovieCollectionTimeline
              days={movieDailyTrend}
              closingGrossPaise={showClosingGross ? model.totals.collectionPaise : null}
            />
          )}

          {appliedReport?.reportType === "movie" && movieReportSection === "theatre" ? (
            <section className="report-panel report-panel--enter report-results report-results--movie" id="movie-report-theatre-wise" aria-live="polite">
              <header className="report-panel__header"><h2>Theatre-wise collection</h2></header>
              <div className="report-result__head"><span>Theatre</span><span>Shows</span><span>Tickets</span><span>Gross</span></div>
              <div className="report-result__body">
                {model.rows.map((row) => <ReportRow key={row.key} row={row} groupBy="theatre" allowDetails={false} />)}
              </div>
            </section>
          ) : appliedReport?.reportType !== "movie" ? (
            <section className="report-results" aria-live="polite">
              <header>
                <div>
                  <p className="eyebrow">{displayReportDate(appliedReport?.startDate || startDate)} — {displayReportDate(appliedReport?.endDate || endDate)}</p>
                  <h2>Theatre performance</h2>
                </div>
              </header>
              <div className="report-result__head"><span>Theatre</span><span>Shows</span><span>Tickets</span><span>Gross</span></div>
              <div className="report-result__body">
                {model.rows.map((row) => <ReportRow key={row.key} row={row} groupBy="theatre" />)}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </section>
  );
}
