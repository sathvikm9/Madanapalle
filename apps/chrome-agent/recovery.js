export const RECOVERY_VENUES = Object.freeze(["SKMD", "SCM", "RTDM", "ASRM"]);

const RECOVERY_VENUE_SET = new Set(RECOVERY_VENUES);

export function supportsRecovery(show) {
  const expectedPlatform = show?.venueCode === "SCM" ? "ticketnew" : "bookmyshow";
  return show?.platform === expectedPlatform && RECOVERY_VENUE_SET.has(show?.venueCode);
}

export function captureModeFor(show, state = {}) {
  return supportsRecovery(show) && state.recoveryMode ? "recovery" : "primary";
}

export function successfulAttemptAlreadyHandled(error, state = {}) {
  const failedAttemptId = String(error?.captureAttemptId || "");
  return Boolean(failedAttemptId && state.lastSuccessAttemptId === failedAttemptId);
}

export function refreshedRecoveryShow(show, candidates = []) {
  return candidates.find((candidate) => candidate.slotKey === show?.slotKey) || show;
}

export function recoveryChanges(show, state = {}, failure = {}, now = new Date()) {
  if (!supportsRecovery(show) || failure.stage === "upload_capture") return null;
  const observedAt = now.toISOString();
  const message = String(failure.error || "Booking-site capture failed");
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
