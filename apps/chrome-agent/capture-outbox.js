export const CAPTURE_OUTBOX_ALARM = "capture-outbox:flush";
export const CAPTURE_OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export function createCaptureOutboxEntry(show, result, queuedAt = new Date().toISOString()) {
  const clientCaptureId = String(result.clientCaptureId || result.attemptId || show.attemptId || "").trim();
  if (!clientCaptureId) throw new Error("A captured result is missing its durable upload ID");
  return {
    clientCaptureId,
    queuedAt,
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    show: {
      naturalKey: show.naturalKey,
      venueCode: show.venueCode,
      dateCode: show.dateCode,
      showTimeLabel: show.showTimeLabel,
      captureAt: show.captureAt,
      finalCaptureAt: show.finalCaptureAt,
      cutoffAt: show.cutoffAt,
      captureMode: show.captureMode || "primary"
    },
    payload: {
      ...result,
      clientCaptureId,
      queuedAt
    }
  };
}

export function orderedCaptureOutbox(outbox = {}) {
  return Object.values(outbox).sort((left, right) => {
    const leftTime = new Date(left?.payload?.capturedAt || left?.queuedAt || 0).getTime();
    const rightTime = new Date(right?.payload?.capturedAt || right?.queuedAt || 0).getTime();
    return leftTime - rightTime;
  });
}

export function protectedCaptureAt(state = {}) {
  const uploaded = new Date(state.lastSuccessAt || 0).getTime();
  const local = new Date(state.lastLocalCaptureAt || 0).getTime();
  const latest = Math.max(Number.isFinite(uploaded) ? uploaded : 0, Number.isFinite(local) ? local : 0);
  return latest || null;
}

export function captureKind(show, result) {
  if (result.housefullEvidence) return "Verified housefull";
  const finalAt = new Date(show.finalCaptureAt || new Date(show.cutoffAt).getTime() - 60_000).getTime();
  return new Date(result.capturedAt).getTime() >= finalAt ? "Final" : "Backup";
}
