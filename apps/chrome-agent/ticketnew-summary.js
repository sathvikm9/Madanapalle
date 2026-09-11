export const TICKETNEW_SUMMARY_METHOD = "ticketnew-summary-estimate";
export const FINAL_SUMMARY_BEFORE_CUTOFF_MS = 50_000;

function timestamp(value) {
  if (value == null || value === "") return null;
  const result = new Date(value || 0).getTime();
  return Number.isFinite(result) ? result : null;
}

export function isTicketNewSummary(result = {}) {
  return result.captureMethod === TICKETNEW_SUMMARY_METHOD;
}

export function finalSummaryWhen(show) {
  const cutoff = timestamp(show?.cutoffAt);
  return cutoff == null ? null : cutoff - FINAL_SUMMARY_BEFORE_CUTOFF_MS;
}

export function needsBackupSummary(show, state = {}, now = Date.now()) {
  if (show?.venueCode !== "SCM" || show?.platform !== "ticketnew") return false;
  if (state.summaryBackupAttemptedAt) return false;
  const captureStart = timestamp(show.captureAt);
  const cutoff = timestamp(show.cutoffAt);
  const finalStart = timestamp(show.finalCaptureAt) ?? (cutoff == null ? null : cutoff - 60_000);
  return captureStart != null && finalStart != null && now >= captureStart && now < finalStart;
}

export function finalLiveCaptureAt(state = {}) {
  const values = [
    state.lastLocalLiveCaptureAt,
    state.lastLiveSuccessAt,
    // These legacy fields contained only live captures before summary fallback existed.
    state.lastLocalCaptureAt,
    state.lastSuccessAt
  ].map(timestamp).filter((value) => value != null);
  return values.length ? Math.max(...values) : null;
}

export function hasFinalLiveCapture(show, state = {}) {
  const cutoff = timestamp(show?.cutoffAt);
  const finalStart = timestamp(show?.finalCaptureAt) ?? (cutoff == null ? null : cutoff - 60_000);
  const liveAt = finalLiveCaptureAt(state);
  return finalStart != null && liveAt != null && liveAt >= finalStart;
}

export function hasAnyLiveCapture(show, state = {}) {
  const captureStart = timestamp(show?.captureAt);
  const cutoff = timestamp(show?.cutoffAt);
  const liveAt = finalLiveCaptureAt(state);
  return captureStart != null && cutoff != null && liveAt != null && liveAt >= captureStart && liveAt < cutoff;
}
