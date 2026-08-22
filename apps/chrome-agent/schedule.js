const ATTEMPT_SECOND_OFFSET_MS = 5_000;

function timestamp(value) {
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
}

function minuteStart(value) {
  return Math.floor(value / 60_000) * 60_000;
}

export function finalCaptureAt(show) {
  const explicit = timestamp(show.finalCaptureAt);
  const cutoff = timestamp(show.cutoffAt);
  return explicit ?? (cutoff == null ? null : cutoff - 60_000);
}

export function nextCaptureWhen(show, state = {}, now = Date.now()) {
  const windowStart = timestamp(show.captureAt);
  const finalStart = finalCaptureAt(show);
  const cutoff = timestamp(show.cutoffAt);
  if (windowStart == null || finalStart == null || cutoff == null || now >= cutoff) return null;

  const firstAttempt = windowStart + ATTEMPT_SECOND_OFFSET_MS;
  const finalAttempt = finalStart + ATTEMPT_SECOND_OFFSET_MS;
  const lastAttempt = timestamp(state.lastAttemptAt);
  const lastSuccess = timestamp(state.lastSuccessAt);

  if (lastSuccess != null) {
    if (lastSuccess >= finalStart || (lastAttempt != null && lastAttempt >= finalStart)) return null;
    return now <= finalAttempt ? finalAttempt : Math.min(now + 1_000, cutoff - 1_000);
  }

  if (now <= firstAttempt) return firstAttempt;
  if (lastAttempt == null || minuteStart(lastAttempt) < minuteStart(now)) {
    return Math.min(now + 1_000, cutoff - 1_000);
  }

  const nextMinuteAttempt = minuteStart(now) + 60_000 + ATTEMPT_SECOND_OFFSET_MS;
  return nextMinuteAttempt < cutoff ? nextMinuteAttempt : null;
}

export function preflightTimes(show) {
  const windowStart = timestamp(show.captureAt);
  const finalStart = finalCaptureAt(show);
  if (windowStart == null || finalStart == null) return [];
  return [windowStart - 90_000, finalStart - 45_000]
    .filter((value, index, values) => values.indexOf(value) === index);
}

export function canPauseVenueDiscovery(shows = [], captureStates = {}, now = Date.now()) {
  const lastShow = shows.reduce((latest, show) => {
    const cutoff = timestamp(show.cutoffAt);
    if (cutoff == null) return latest;
    return !latest || cutoff > latest.cutoff ? { show, cutoff } : latest;
  }, null);
  if (!lastShow || now < lastShow.cutoff) return false;

  const state = captureStates[lastShow.show.naturalKey] || {};
  const lastSuccess = timestamp(state.lastSuccessAt);
  const captureStart = timestamp(lastShow.show.captureAt);
  return lastSuccess != null && captureStart != null &&
    lastSuccess >= captureStart && lastSuccess < lastShow.cutoff;
}
