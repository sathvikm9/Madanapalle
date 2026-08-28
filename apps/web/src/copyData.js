const copyNumber = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

function ordinal(day) {
  const remainder = day % 100;
  if (remainder >= 11 && remainder <= 13) return `${day}th`;
  if (day % 10 === 1) return `${day}st`;
  if (day % 10 === 2) return `${day}nd`;
  if (day % 10 === 3) return `${day}rd`;
  return `${day}th`;
}

function copyDate(date) {
  const [year, month, day] = date.split("-").map(Number);
  const monthName = new Intl.DateTimeFormat("en-IN", { month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day)));
  return `${ordinal(day)} ${monthName}`;
}

function compactTime(time) {
  return String(time || "Show").replace(/\s+/g, "").toUpperCase();
}

function copiedGross(collectionPaise) {
  return `${copyNumber.format(Math.round((collectionPaise || 0) / 100))}/-`;
}

function showsTotal(shows) {
  return shows.reduce((total, show) => total + (show.snapshot?.collectionPaise || 0), 0);
}

function showResult(show) {
  if (show.snapshot) return copiedGross(show.snapshot.collectionPaise);
  if (show.status === "missed") return "Missed";
  if (show.status === "removed") return "Removed";
  if (show.status === "replaced") return "Replaced";
  return "Pending";
}

function theatreName(show) {
  return show.venueShortName || show.venueName || show.venueCode || "Theatre";
}

function formatTheatreShows(shows) {
  const movieNames = new Set(shows.map((show) => show.movieTitle).filter(Boolean));
  const singleMovie = movieNames.size === 1 ? [...movieNames][0] : "";
  const lines = [];

  if (singleMovie) lines.push(singleMovie);
  for (const show of shows) {
    const pieces = [compactTime(show.showTime)];
    if (!singleMovie) pieces.push(show.movieTitle || "Movie unavailable");
    pieces.push(showResult(show));
    lines.push(pieces.join(" - "));
  }

  lines.push(`Total - ${copiedGross(showsTotal(shows))}`);

  return lines;
}

export function buildShowsCopyText({ date, theatre, shows, allTheatres = false }) {
  const heading = `${copyDate(date)} - ${theatre}`;
  if (!shows.length) return `${heading}\nNo shows found.`;

  if (!allTheatres) return [heading, "", ...formatTheatreShows(shows)].join("\n");

  const groups = new Map();
  for (const show of shows) {
    const name = theatreName(show);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(show);
  }

  const sections = [...groups.entries()].map(([name, theatreShows]) => (
    [name, ...formatTheatreShows(theatreShows)].join("\n")
  ));
  return `${heading}\n\n${sections.join("\n\n")}`;
}

export function buildMoviesCopyText({ date, theatre, movies }) {
  const heading = `${copyDate(date)} - ${theatre}`;
  if (!movies.length) return `${heading}\nNo movies found.`;

  const lines = movies.map((movie) => {
    const count = movie.shows.length;
    return `${movie.movieTitle} - ${count} ${count === 1 ? "Show" : "Shows"} - ${copiedGross(movie.collectionPaise)}`;
  });
  return [heading, "", ...lines].join("\n");
}
