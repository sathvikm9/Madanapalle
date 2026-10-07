import { protectedCaptureAt } from "./capture-outbox.js";
import { finalCaptureAt } from "./schedule.js";

function timestamp(value) {
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
}

export function captureFailureAlertPhase(show, state = {}, attemptedAt = Date.now()) {
  if (protectedCaptureAt(state) != null) return null;
  const attempt = timestamp(attemptedAt);
  const finalAt = finalCaptureAt(show);
  const finalAttempt = attempt != null && finalAt != null && attempt >= finalAt;
  if (finalAttempt) return state.finalFailureAlertAcceptedAt ? null : "final";
  return state.initialFailureAlertAcceptedAt ? null : "initial";
}

export function acceptedAlertStateField(phase) {
  return phase === "final" ? "finalFailureAlertAcceptedAt" : "initialFailureAlertAcceptedAt";
}

export function localAlertStateField(phase) {
  return phase === "final" ? "finalFailureLocalAlertAt" : "initialFailureLocalAlertAt";
}

export function captureFailureAlertTitle(venueName, showTime, phase) {
  const displayTime = String(showTime || "").replace(/^0(?=\d:)/, "");
  const base = `${venueName} ${displayTime}`;
  return phase === "final"
    ? `${base} final capture failed`
    : `${base} capture failed - CHECK NOW`;
}
