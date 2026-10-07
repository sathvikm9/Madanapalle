const whole = new Intl.NumberFormat("en-IN");
const money = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0
});

const TOTAL_KEYS = ["screenedShows", "capturedShows", "housefullShows", "ticketsSold", "capacity", "collectionPaise"];

function emptyTotals() {
  return {
    screenedShows: 0,
    capturedShows: 0,
    housefullShows: 0,
    ticketsSold: 0,
    capacity: 0,
    collectionPaise: 0
  };
}

function addTotals(target, source = {}) {
  for (const key of TOTAL_KEYS) target[key] += Number(source[key] || 0);
  return target;
}

function normalizedLabel(value) {
  return String(value || "").trim().toLocaleLowerCase("en-IN");
}

export function sortMoviesByGross(movies) {
  return [...(Array.isArray(movies) ? movies : [])].sort((left, right) =>
    Number(right?.collectionPaise || 0) - Number(left?.collectionPaise || 0)
    || Number(right?.ticketsSold || 0) - Number(left?.ticketsSold || 0)
    || String(right?.lastTrackedDate || right?.firstTrackedDate || "").localeCompare(String(left?.lastTrackedDate || left?.firstTrackedDate || ""))
    || String(left?.title || "").localeCompare(String(right?.title || ""))
  );
}

export function defaultReportStartDate(endDate, firstDate, days = 30) {
  const date = new Date(`${endDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - Math.max(0, days - 1));
  const startDate = date.toISOString().slice(0, 10);
  return startDate < firstDate ? firstDate : startDate;
}

export function previousReportDate(currentDate, firstDate = "2026-08-21") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(currentDate || ""))) return firstDate;
  const date = new Date(`${currentDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  const previousDate = date.toISOString().slice(0, 10);
  return previousDate < firstDate ? firstDate : previousDate;
}

export function movieReportStartDate(movie, firstDate) {
  const candidates = [movie?.premiereDate, movie?.dayOneDate, movie?.firstTrackedDate];
  return candidates.find((date) => /^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) || firstDate;
}

function addIsoDays(date, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return null;
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function movieReportRange(movie, view = "full", maxDate) {
  if (!movie) return null;
  const firstTrackedDate = movie.firstTrackedDate || movie.dayOneDate || maxDate;
  const runStartDate = movieReportStartDate(movie, firstTrackedDate);
  const dayOneDate = movie.dayOneDate || firstTrackedDate;
  const fullRunEnd = [movie.lastTrackedDate, maxDate]
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")))
    .sort()[0] || runStartDate;

  let endDate = fullRunEnd;
  if (view === "opening") endDate = [dayOneDate, fullRunEnd].sort()[0];
  if (view === "week1") endDate = [addIsoDays(dayOneDate, 6), fullRunEnd].filter(Boolean).sort()[0];

  return {
    startDate: runStartDate,
    endDate: endDate < runStartDate ? runStartDate : endDate,
    hasPremiere: Boolean(movie.premiereDate),
    fullRunStartDate: runStartDate,
    fullRunEndDate: fullRunEnd
  };
}

export function reportSummaryQuery({ movieTitle, venueCode, startDate, endDate, completeDaysOnly = false }) {
  return new URLSearchParams({
    movie: movieTitle,
    venueCode,
    startDate,
    endDate,
    ...(completeDaysOnly ? { completeDaysOnly: "1" } : {})
  });
}

export function completedReportEndDate(summaries, requestedEndDate) {
  return (Array.isArray(summaries) ? summaries : [])
    .map((summary) => summary?.endDate)
    .filter(Boolean)
    .sort()[0] || requestedEndDate;
}

export function trackedReportDays(summaries) {
  const dates = new Set();
  for (const summary of Array.isArray(summaries) ? summaries : []) {
    for (const day of summary?.days || []) {
      if (day?.date && Number(day.screenedShows || 0) > 0) dates.add(day.date);
    }
  }
  return dates.size;
}

export function screenedDaysLabel(screenedDays, hasPremiere = false) {
  const days = Math.max(0, Number(screenedDays || 0));
  if (!hasPremiere || days === 0) return whole.format(days);
  if (days === 1) return "Prem";
  return `Prem + ${whole.format(days - 1)}`;
}

export function buildReportModel(summaries, groupBy = "theatre", sortBy = "tickets") {
  const source = Array.isArray(summaries) ? summaries : [];
  const totals = source.reduce((result, summary) => addTotals(result, summary?.total), emptyTotals());
  const rows = new Map();

  function addRow(key, label, values, detail) {
    const current = rows.get(key) || { key, label, ...emptyTotals(), details: new Map() };
    addTotals(current, values);
    if (detail) {
      const detailKey = normalizedLabel(detail.label);
      const currentDetail = current.details.get(detailKey) || {
        key: `${key}-${detailKey}`,
        label: detail.label,
        ...emptyTotals()
      };
      addTotals(currentDetail, detail);
      current.details.set(detailKey, currentDetail);
    }
    rows.set(key, current);
  }

  for (const summary of source) {
    if (groupBy === "date") {
      for (const day of summary?.days || []) addRow(day.date, day.date, day);
      continue;
    }

    for (const venue of summary?.venues || []) {
      if (groupBy === "theatre") {
        addRow(venue.code, venue.name, venue);
        for (const movie of venue.movies || []) {
          const row = rows.get(venue.code);
          const detailKey = normalizedLabel(movie.title);
          const currentDetail = row.details.get(detailKey) || {
            key: `${venue.code}-${detailKey}`,
            label: movie.title,
            ...emptyTotals()
          };
          addTotals(currentDetail, movie);
          row.details.set(detailKey, currentDetail);
        }
      } else {
        for (const movie of venue.movies || []) {
          const key = normalizedLabel(movie.title);
          addRow(key, movie.title, movie, { ...movie, label: venue.name });
        }
      }
    }
  }

  const sortKeys = {
    tickets: "ticketsSold",
    gross: "collectionPaise",
    shows: "screenedShows"
  };
  const sortKey = sortKeys[sortBy] || sortKeys.tickets;
  const resultRows = Array.from(rows.values()).map((row) => ({
    ...row,
    details: Array.from(row.details.values()).sort((left, right) =>
      right.collectionPaise - left.collectionPaise || left.label.localeCompare(right.label)
    )
  }));
  resultRows.sort((left, right) => right[sortKey] - left[sortKey] || left.label.localeCompare(right.label));

  return { totals, rows: resultRows, groupBy, sortBy };
}

export function reportText({ startDate, endDate, title = "MPLTalkies report", model }) {
  const lines = [
    `${title} — ${startDate} to ${endDate}`,
    `Shows: ${whole.format(model.totals.screenedShows)} · Tickets: ${whole.format(model.totals.ticketsSold)} · Gross: ${money.format(model.totals.collectionPaise / 100)}`,
    ""
  ];
  for (const row of model.rows) {
    lines.push(`${row.label} — ${whole.format(row.screenedShows)} shows · ${whole.format(row.ticketsSold)} tickets · ${money.format(row.collectionPaise / 100)}`);
  }
  return lines.join("\n");
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export function reportCsv(model) {
  const lines = [["Name", "Shows", "Captured", "Tickets", "Gross (INR)"]];
  for (const row of model.rows) {
    lines.push([
      row.label,
      row.screenedShows,
      row.capturedShows,
      row.ticketsSold,
      (row.collectionPaise / 100).toFixed(0)
    ]);
  }
  return lines.map((line) => line.map(csvCell).join(",")).join("\n");
}
