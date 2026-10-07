import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildReportModel,
  completedReportEndDate,
  movieReportRange,
  previousReportDate,
  reportSummaryQuery,
  screenedDaysLabel,
  sortMoviesByGross,
  trackedReportDays
} from "./reports.js";

const number = new Intl.NumberFormat("en-IN");
const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
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

function distributedTotal(total, index, count) {
  const wholeTotal = Math.max(0, Math.round(Number(total || 0)));
  return Math.floor(wholeTotal / count) + (index < wholeTotal % count ? 1 : 0);
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
    return {
      startDate,
      endDate,
      total: totals,
      venues: [{ code, name, movies: selectedMovies, ...totals }],
      days: reportDates.map((date, index) => ({
        date,
        screenedShows: distributedTotal(totals.screenedShows, index, reportDates.length),
        capturedShows: distributedTotal(totals.capturedShows, index, reportDates.length),
        housefullShows: distributedTotal(totals.housefullShows, index, reportDates.length),
        ticketsSold: distributedTotal(totals.ticketsSold, index, reportDates.length),
        capacity: distributedTotal(totals.capacity, index, reportDates.length),
        collectionPaise: distributedTotal(totals.collectionPaise, index, reportDates.length)
      }))
    };
  });
}

function MoviePicker({ loading, movies, selectedMovie, onSelect }) {
  const [query, setQuery] = useState(selectedMovie?.title || "");
  const [open, setOpen] = useState(false);
  const [filterActive, setFilterActive] = useState(false);
  const pickerRef = useRef(null);
  const filteredMovies = useMemo(() => {
    const wanted = filterActive ? query.trim().toLocaleLowerCase("en-IN") : "";
    return movies.filter((movie) => !wanted || movie.title.toLocaleLowerCase("en-IN").includes(wanted));
  }, [filterActive, movies, query]);

  useEffect(() => {
    setQuery(selectedMovie?.title || "");
    setFilterActive(false);
  }, [selectedMovie]);
  useEffect(() => {
    if (!open) return undefined;
    function closeOutside(event) {
      if (!pickerRef.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  function choose(movie) {
    setQuery(movie.title);
    setFilterActive(false);
    onSelect(movie);
    setOpen(false);
  }

  return (
    <div className="movie-picker" ref={pickerRef}>
      <label htmlFor="report-movie-search"><span>Movie</span></label>
      <div className={`movie-picker__control${open ? " is-open" : ""}`}>
        <span className="movie-picker__search" aria-hidden="true" />
        <input
          id="report-movie-search"
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="report-movie-options"
          aria-expanded={open}
          autoComplete="off"
          placeholder={loading ? "Loading movies…" : "Search and select a movie"}
          value={query}
          onFocus={(event) => {
            setFilterActive(false);
            setOpen(true);
            event.currentTarget.select();
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setFilterActive(true);
            setOpen(true);
          }}
        />
        <button type="button" aria-label="Show all movies" onClick={() => setOpen((current) => {
          if (!current) setFilterActive(false);
          return !current;
        })}>⌄</button>
      </div>
      {open && (
        <div className="movie-picker__menu" id="report-movie-options" role="listbox" aria-label="Tracked movies">
          <p>{movies.length} tracked movies · Highest gross first</p>
          {filteredMovies.length ? filteredMovies.map((movie) => (
            <button
              type="button"
              role="option"
              aria-selected={movie.title === selectedMovie?.title}
              className={movie.title === selectedMovie?.title ? "is-selected" : ""}
              key={movie.title}
              onClick={() => choose(movie)}
            >
              <span><strong>{movie.title}</strong><small>Tracked {displayReportDate(movie.firstTrackedDate)} — {displayReportDate(movie.lastTrackedDate)}</small></span>
              <i aria-hidden="true">{movie.title === selectedMovie?.title ? "✓" : "→"}</i>
            </button>
          )) : <span className="movie-picker__empty">No matching movies</span>}
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
    <details className="report-result__expandable">
      <summary className="report-result__row">{content}<i aria-hidden="true">⌄</i></summary>
      <div className="report-result__details">
        {row.details.map((detail) => (
          <div key={detail.key}>
            <span>{detail.label}</span>
            <span>{number.format(detail.screenedShows)} shows</span>
            <span>{number.format(detail.ticketsSold)} tickets</span>
            <strong>{money.format(detail.collectionPaise / 100)}</strong>
          </div>
        ))}
      </div>
    </details>
  );
}

export default function ReportsView({ apiBase, demo, initialVenue, maxDate, theatres }) {
  const reportTheatres = useMemo(() => theatres.filter((theatre) => theatre.code !== "ALL"), [theatres]);
  const allCodes = useMemo(() => reportTheatres.map((theatre) => theatre.code), [reportTheatres]);
  const demoMovies = useMemo(() => sortMoviesByGross(DEMO_MOVIES), []);
  const initialDemoMovie = demo ? demoMovies.find((movie) => movie.title === "The Paradise") || demoMovies[0] : null;
  const theatreReportMaxDate = useMemo(() => previousReportDate(maxDate), [maxDate]);
  const [startDate, setStartDate] = useState("2026-08-21");
  const [endDate, setEndDate] = useState(() => previousReportDate(maxDate));
  const [selectedCodes, setSelectedCodes] = useState(() => initialVenue === "ALL" ? allCodes : [initialVenue]);
  const [reportType, setReportType] = useState("movie");
  const [movieOptions, setMovieOptions] = useState(() => demo ? demoMovies : []);
  const [movieCatalogLoading, setMovieCatalogLoading] = useState(false);
  const [movieCatalogError, setMovieCatalogError] = useState("");
  const [selectedMovie, setSelectedMovie] = useState(initialDemoMovie);
  const [movieView, setMovieView] = useState("full");
  const [summaries, setSummaries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [appliedReport, setAppliedReport] = useState(null);
  const autoMovieReportRef = useRef("");

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
        const highestGrossingMovie = movies[0] || null;
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
  }, [apiBase, demo, maxDate, movieOptions.length]);

  const selectedMovieRange = useMemo(
    () => movieReportRange(selectedMovie, movieView, maxDate),
    [maxDate, movieView, selectedMovie]
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
      setSummaries(nextSummaries);
      setAppliedReport({
        startDate: reportStartDate,
        endDate: includedEndDate,
        reportType,
        movieTitle,
        movieView: reportType === "movie" ? movieView : null,
        movie: reportType === "movie" ? selectedMovie : null
      });
    } catch (requestError) {
      setError(requestError.message || "The report could not be generated.");
    } finally {
      setLoading(false);
    }
  }, [allCodes, apiBase, demo, endDate, movieView, reportTheatres, reportType, selectedCodes, selectedMovie, selectedMovieRange, startDate]);

  useEffect(() => {
    if (reportType !== "movie" || !selectedMovie?.title || !selectedMovieRange) return;
    const reportKey = `${selectedMovie.title}|${movieView}|${selectedMovieRange.startDate}|${selectedMovieRange.endDate}`;
    if (autoMovieReportRef.current === reportKey) return;
    autoMovieReportRef.current = reportKey;
    void runReport();
  }, [movieView, reportType, runReport, selectedMovie, selectedMovieRange]);

  const appliedSortBy = appliedReport?.reportType === "movie" ? "gross" : "tickets";
  const model = useMemo(() => buildReportModel(summaries, "theatre", appliedSortBy), [appliedSortBy, summaries]);
  const screenedDays = useMemo(() => trackedReportDays(summaries), [summaries]);
  const screenedDaysDisplay = screenedDaysLabel(screenedDays, Boolean(appliedReport?.movie?.premiereDate));
  const allSelected = selectedCodes.length === allCodes.length;

  function chooseMovie(movie) {
    setSelectedMovie(movie);
    setMovieView("full");
    autoMovieReportRef.current = "";
    setSummaries([]);
    setAppliedReport(null);
    setError("");
  }

  function changeReportType(nextType) {
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
          {selectedMovie && (
            <fieldset className="movie-report-period">
              <legend>View by</legend>
              <div>
                <button type="button" className={movieView === "opening" ? "is-active" : ""} aria-pressed={movieView === "opening"} onClick={() => setMovieView("opening")}>
                  {selectedMovie.premiereDate ? "Prem + Day 1" : "Day 1"}
                </button>
                <button type="button" className={movieView === "week1" ? "is-active" : ""} aria-pressed={movieView === "week1"} onClick={() => setMovieView("week1")}>1st Week</button>
                <button type="button" className={movieView === "full" ? "is-active" : ""} aria-pressed={movieView === "full"} onClick={() => setMovieView("full")}>Full Run</button>
              </div>
            </fieldset>
          )}
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
        {reportType === "movie" && loading && <p className="report-auto-status" role="status">Updating movie report…</p>}
      </form>

      {error && <div className="report-error" role="alert">{error}</div>}

      {!error && summaries.length > 0 && (
        <>
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
            <section className="movie-report-overview" aria-label="Movie report totals">
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

          <section className={`report-results${appliedReport?.reportType === "movie" ? " report-results--movie" : ""}`} aria-live="polite">
            {appliedReport?.reportType === "movie" ? (
              <header className="report-results__movie-header"><h2>Theatre-wise collection</h2></header>
            ) : (
              <header>
                <div>
                  <p className="eyebrow">{displayReportDate(appliedReport?.startDate || startDate)} — {displayReportDate(appliedReport?.endDate || endDate)}</p>
                  <h2>Theatre performance</h2>
                </div>
              </header>
            )}
            <div className="report-result__head"><span>Theatre</span><span>Shows</span><span>Tickets</span><span>Gross</span></div>
            <div className="report-result__body">
              {model.rows.map((row) => <ReportRow key={row.key} row={row} groupBy="theatre" allowDetails={appliedReport?.reportType !== "movie"} />)}
            </div>
          </section>
        </>
      )}
    </section>
  );
}
