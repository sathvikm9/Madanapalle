const THEATRE_PRIORITY = new Map([
  ["RTDM", 0],
  ["ASRM", 1],
  ["SCM", 2],
  ["SKMD", 3]
]);

function showTimestamp(show) {
  const timestamp = new Date(show?.startAt || "").getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

function theatrePriority(show) {
  return THEATRE_PRIORITY.get(show?.venueCode) ?? THEATRE_PRIORITY.size;
}

export function sortShowsForDisplay(shows = []) {
  return [...shows].sort((left, right) =>
    showTimestamp(left) - showTimestamp(right)
    || theatrePriority(left) - theatrePriority(right)
    || String(left?.venueShortName || left?.venueName || left?.venueCode || "")
      .localeCompare(String(right?.venueShortName || right?.venueName || right?.venueCode || ""))
    || String(left?.id || "").localeCompare(String(right?.id || ""))
  );
}
