const INDIA_TIME_ZONE = "Asia/Kolkata";
export const PREMIERE_START_HOUR = 18;

const MOVIE_RUN_EXCLUDED_TITLES = new Set([
  "awarapan 2",
  "hushar pittalu",
  "vishwanath and sons"
]);

const MOVIE_TITLE_ALIASES = new Map([
  ["aakasamlo oka tara", { key: "aakasamlo oka tara", title: "Aakasamlo Oka Tara" }],
  ["aakasam lo oka tara", { key: "aakasamlo oka tara", title: "Aakasamlo Oka Tara" }],
  ["aot aakasamlo oka tara", { key: "aakasamlo oka tara", title: "Aakasamlo Oka Tara" }],
  ["aot aakasam lo oka tara", { key: "aakasamlo oka tara", title: "Aakasamlo Oka Tara" }]
]);

const indiaDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: INDIA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

const indiaHourFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: INDIA_TIME_ZONE,
  hour: "2-digit",
  hourCycle: "h23"
});

function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function addCalendarDays(date, days) {
  if (!validIsoDate(date)) return null;
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + Number(days || 0));
  return value.toISOString().slice(0, 10);
}

function calendarDayDifference(startDate, endDate) {
  if (!validIsoDate(startDate) || !validIsoDate(endDate)) return null;
  return Math.round((new Date(`${endDate}T00:00:00.000Z`) - new Date(`${startDate}T00:00:00.000Z`)) / 86_400_000);
}

function rawMovieTitleKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-IN")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function movieTitleKey(value) {
  const key = rawMovieTitleKey(value);
  return MOVIE_TITLE_ALIASES.get(key)?.key || key;
}

export function canonicalMovieTitle(value) {
  const alias = MOVIE_TITLE_ALIASES.get(rawMovieTitleKey(value));
  if (alias) return alias.title;
  return String(value || "").trim().replace(/:+$/u, "").trim();
}

export function movieRunIsAvailable(movieTitle) {
  return !MOVIE_RUN_EXCLUDED_TITLES.has(movieTitleKey(movieTitle));
}

export function ordinal(value) {
  const number = Math.max(1, Math.trunc(Number(value) || 1));
  const lastTwo = number % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${number}th`;
  if (number % 10 === 1) return `${number}st`;
  if (number % 10 === 2) return `${number}nd`;
  if (number % 10 === 3) return `${number}rd`;
  return `${number}th`;
}

export function movieReleaseSchedule(firstShowAt, officialReleaseDate = null, officialReleaseSource = "bookmyshow") {
  const firstShow = new Date(firstShowAt);
  if (!Number.isFinite(firstShow.getTime())) return null;

  const firstTrackedDate = indiaDateFormatter.format(firstShow);
  const firstShowHour = Number(indiaHourFormatter.format(firstShow));
  const hasOfficialReleaseDate = validIsoDate(officialReleaseDate);
  const isReRelease = hasOfficialReleaseDate && firstTrackedDate > officialReleaseDate;
  const hasPremiere = hasOfficialReleaseDate
    ? firstTrackedDate < officialReleaseDate
    : firstShowHour >= PREMIERE_START_HOUR;
  const premiereDate = hasPremiere ? firstTrackedDate : null;
  const dayOneDate = isReRelease
    ? firstTrackedDate
    : hasOfficialReleaseDate
      ? officialReleaseDate
      : hasPremiere
        ? addCalendarDays(firstTrackedDate, 1)
        : firstTrackedDate;

  return {
    firstShowAt: firstShow.toISOString(),
    firstTrackedDate,
    firstShowHour,
    officialReleaseDate: hasOfficialReleaseDate ? officialReleaseDate : null,
    releaseDateSource: hasOfficialReleaseDate ? String(officialReleaseSource || "verified") : "first-show-fallback",
    isReRelease,
    hasPremiere,
    premiereDate,
    dayOneDate
  };
}

export function movieRunForDate(firstShowAt, selectedDate, { releaseDate = null, releaseDateSource = "bookmyshow" } = {}) {
  const release = movieReleaseSchedule(firstShowAt, releaseDate, releaseDateSource);
  if (!release || !validIsoDate(selectedDate)) return null;

  if (release.isReRelease) {
    if (calendarDayDifference(release.firstTrackedDate, selectedDate) < 0) return null;
    return {
      ...release,
      selectedDate,
      phase: "re-release",
      dayNumber: null,
      dayLabel: "Re-Release",
      weekNumber: null,
      weekLabel: null
    };
  }

  if (release.premiereDate === selectedDate) {
    return {
      ...release,
      selectedDate,
      phase: "premiere",
      dayNumber: null,
      dayLabel: "Premieres",
      weekNumber: null,
      weekLabel: null
    };
  }

  const offset = calendarDayDifference(release.dayOneDate, selectedDate);
  if (offset == null || offset < 0) return null;
  const dayNumber = offset + 1;
  const weekNumber = Math.ceil(dayNumber / 7);

  return {
    ...release,
    selectedDate,
    phase: "day",
    dayNumber,
    dayLabel: `Day ${dayNumber}`,
    weekNumber,
    weekLabel: dayNumber >= 7 ? `${ordinal(weekNumber)} Week` : null
  };
}
