export const BOOKMYSHOW_RECOVERY_VENUES = Object.freeze(["SKMD", "RTDM", "ASRM"]);

const RECOVERY_VENUE_SET = new Set(BOOKMYSHOW_RECOVERY_VENUES);

export function supportsRecovery(show) {
  return show?.platform === "bookmyshow" && RECOVERY_VENUE_SET.has(show?.venueCode);
}

export function captureModeFor(show, state = {}) {
  return supportsRecovery(show) && state.recoveryMode ? "recovery" : "primary";
}

export function refreshedRecoveryShow(show, candidates = []) {
  return candidates.find((candidate) => candidate.slotKey === show?.slotKey) || show;
}

export function recoveryChanges(show, state = {}, failure = {}, now = new Date()) {
  if (!supportsRecovery(show) || failure.stage === "upload_capture") return null;
  const observedAt = now.toISOString();
  const message = String(failure.error || "BookMyShow capture failed");
  return {
    recoveryMode: true,
    recoveryStartedAt: state.recoveryStartedAt || observedAt,
    recoveryReason: `${failure.stage || "capture"}: ${message}`.slice(0, 500),
    recoveryFailures: Number(state.recoveryFailures || 0) + 1,
    lastRecoveryFailureAt: observedAt,
    lastRecoveryStage: String(failure.stage || "capture").slice(0, 100),
    lastRecoveryPageKind: failure.diagnostics?.pageKind || null
  };
}
