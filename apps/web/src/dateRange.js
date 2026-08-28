export const FIRST_LIVE_DATE = "2026-08-21";
const INDIA_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function indiaToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
  );
  return `${values.year}-${values.month}-${values.day}`;
}

export function clampDashboardDate(value, latestDate = indiaToday()) {
  const maximum = latestDate < FIRST_LIVE_DATE ? FIRST_LIVE_DATE : latestDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return maximum;
  if (value < FIRST_LIVE_DATE) return FIRST_LIVE_DATE;
  if (value > maximum) return maximum;
  return value;
}

export function millisecondsUntilNextIndiaMidnight(now = new Date()) {
  const indiaTimestamp = now.getTime() + INDIA_OFFSET_MS;
  const nextMidnight = (Math.floor(indiaTimestamp / DAY_MS) + 1) * DAY_MS;
  return nextMidnight - indiaTimestamp;
}
