const INDIA_OFFSET = "+05:30";

export function bmsCodeToIso(value) {
  const code = String(value || "");
  if (!/^\d{12}$/.test(code)) {
    throw new Error(`Invalid BookMyShow datetime code: ${value}`);
  }

  return `${code.slice(0, 4)}-${code.slice(4, 6)}-${code.slice(6, 8)}T${code.slice(8, 10)}:${code.slice(10, 12)}:00${INDIA_OFFSET}`;
}

export function captureAtFromCutoff(cutoffIso, minutesBefore = 1) {
  return new Date(new Date(cutoffIso).getTime() - minutesBefore * 60_000).toISOString();
}

export function captureAtFromStart(showStartIso, minutesAfter = 10) {
  return new Date(new Date(showStartIso).getTime() + minutesAfter * 60_000).toISOString();
}

export function cutoffFromStart(showStartIso, minutesAfter = 15) {
  return new Date(new Date(showStartIso).getTime() + minutesAfter * 60_000).toISOString();
}

export function indiaDateCode(date = new Date(), daysAhead = 0) {
  const shifted = new Date(date.getTime() + daysAhead * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(shifted);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
}

export function isoDateFromCode(dateCode) {
  const value = String(dateCode || "");
  if (!/^\d{8}$/.test(value)) throw new Error(`Invalid date code: ${dateCode}`);
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}
