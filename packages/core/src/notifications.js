const currency = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0
});

const whole = new Intl.NumberFormat("en-IN");

export const SHOW_PERIODS = [
  { key: "early-morning", label: "Early Morning", startMinute: 3 * 60, endMinute: 9 * 60 + 30 },
  { key: "morning", label: "Morning", startMinute: 9 * 60 + 31, endMinute: 12 * 60 },
  { key: "matinee", label: "Matinee", startMinute: 12 * 60 + 1, endMinute: 15 * 60 + 30 },
  { key: "evening", label: "Evening", startMinute: 15 * 60 + 31, endMinute: 19 * 60 },
  { key: "second", label: "Second", startMinute: 19 * 60 + 1, endMinute: 22 * 60 + 30 }
];

export const DEFAULT_NOTIFICATION_TYPES = ["period_results", "schedule_changes", "daily_summary"];

export function minutesFromShowTime(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  const minute = Number(match[2]);
  if (minute > 59) return null;
  if (match[3].toUpperCase() === "PM") hour += 12;
  return hour * 60 + minute;
}

export function showPeriod(value) {
  const minute = minutesFromShowTime(value);
  if (minute == null) return { key: "other", label: "Special" };
  const configured = SHOW_PERIODS.find((period) => minute >= period.startMinute && minute <= period.endMinute);
  if (configured) return configured;
  if (minute < SHOW_PERIODS[0].startMinute || minute > SHOW_PERIODS.at(-1).endMinute) {
    return { key: "late-night", label: "Late Night" };
  }
  return { key: "special", label: "Special" };
}

export function notificationPeriodTitle(periodLabel, showCount) {
  return `${periodLabel} ${showCount === 1 ? "show" : "shows"}`;
}

export function periodResultLine(show) {
  const theatre = show.venueShortName || show.venueName || show.venueCode;
  if (show.status === "missed" || !show.snapshot) {
    return `${theatre} · ${show.showTime} — Data missed`;
  }
  const movie = String(show.movieTitle || "Movie unavailable");
  return `${theatre} · ${show.showTime} — ${movie} · ${currency.format(Number(show.snapshot.collectionPaise || 0) / 100)}`;
}

export function buildPeriodNotification(shows) {
  if (!shows.length) return null;
  const period = showPeriod(shows[0].showTime);
  const ordered = [...shows].sort((left, right) => (
    Number(right.snapshot?.collectionPaise || -1) - Number(left.snapshot?.collectionPaise || -1)
    || minutesFromShowTime(left.showTime) - minutesFromShowTime(right.showTime)
    || String(left.venueShortName || left.venueCode).localeCompare(String(right.venueShortName || right.venueCode))
  ));
  return {
    title: notificationPeriodTitle(period.label, ordered.length),
    body: ordered.map(periodResultLine).join("\n"),
    periodKey: period.key
  };
}

function ordinal(day) {
  const remainder100 = day % 100;
  if (remainder100 >= 11 && remainder100 <= 13) return `${day}th`;
  return `${day}${day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th"}`;
}

export function notificationDateLabel(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  if (!year || !month || !day) return String(value || "");
  const monthName = new Intl.DateTimeFormat("en-IN", { month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day)));
  return `${ordinal(day)} ${monthName}`;
}

export function buildDailySummaryNotification({ showDate, theatreLabel, shows }) {
  const groups = new Map();
  for (const show of shows) {
    if (show.status !== "completed" || !show.snapshot) continue;
    const movie = String(show.movieTitle || "Movie unavailable");
    const current = groups.get(movie) || { title: movie, shows: 0, collectionPaise: 0 };
    current.shows += 1;
    current.collectionPaise += Number(show.snapshot.collectionPaise || 0);
    groups.set(movie, current);
  }
  const movies = [...groups.values()].sort((left, right) => (
    right.collectionPaise - left.collectionPaise || left.title.localeCompare(right.title)
  ));
  return {
    title: `${notificationDateLabel(showDate)} - ${theatreLabel}`,
    body: movies.map((movie) => (
      `${movie.title} - ${movie.shows} ${movie.shows === 1 ? "Show" : "Shows"} - ${whole.format(movie.collectionPaise / 100)}/-`
    )).join("\n")
  };
}
