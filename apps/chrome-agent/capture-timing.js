import { finalCaptureAt } from "./schedule.js";

export const BOOKMYSHOW_FINAL_RECOVERY_TIMEOUT_MS = 18_000;
export const SAI_CHITRA_FINAL_PRIMARY_TIMEOUT_MS = 15_000;
export const SAI_CHITRA_FINAL_PRIMARY_PAGE_LOAD_TIMEOUT_MS = 14_000;
export const SAI_CHITRA_FINAL_RECOVERY_TIMEOUT_MS = 34_000;
export const SAI_CHITRA_FINAL_RECOVERY_CUTOFF_BUFFER_MS = 5_000;

function isSaiChitraFinalAttempt(show, captureMode, now) {
  const finalStart = finalCaptureAt(show);
  return show?.venueCode === "SCM" && show?.platform === "ticketnew" &&
    (captureMode === "primary" || captureMode === "recovery") &&
    finalStart != null && now >= finalStart;
}

export function captureAttemptTimeouts(show, {
  captureMode,
  deadline,
  now = Date.now()
}) {
  const deadlineRemainingMs = Math.max(1_000, Number(deadline) - now);
  const deadlineSafetyMs = Math.max(1_000, deadlineRemainingMs - 1_000);
  const bookMyShowRecovery = show?.platform === "bookmyshow" && captureMode === "recovery";
  const saiChitraFinal = isSaiChitraFinalAttempt(show, captureMode, now);

  if (bookMyShowRecovery) {
    const timeout = Math.max(1_000, Math.min(BOOKMYSHOW_FINAL_RECOVERY_TIMEOUT_MS, deadlineSafetyMs));
    return { watchdogDelayMs: timeout, pageLoadTimeoutMs: timeout };
  }

  if (saiChitraFinal && captureMode === "primary") {
    return {
      watchdogDelayMs: Math.max(
        1_000,
        Math.min(SAI_CHITRA_FINAL_PRIMARY_TIMEOUT_MS, deadlineSafetyMs)
      ),
      pageLoadTimeoutMs: Math.max(
        1_000,
        Math.min(SAI_CHITRA_FINAL_PRIMARY_PAGE_LOAD_TIMEOUT_MS, deadlineSafetyMs)
      )
    };
  }

  if (saiChitraFinal && captureMode === "recovery") {
    const beforeCutoffBuffer = Math.max(
      1_000,
      deadlineRemainingMs - SAI_CHITRA_FINAL_RECOVERY_CUTOFF_BUFFER_MS
    );
    return {
      watchdogDelayMs: Math.min(SAI_CHITRA_FINAL_RECOVERY_TIMEOUT_MS, beforeCutoffBuffer),
      pageLoadTimeoutMs: Math.min(30_000, beforeCutoffBuffer)
    };
  }

  const primaryFinalTimeoutMs = show?.platform === "bookmyshow" && now >= finalCaptureAt(show)
    ? 20_000
    : 30_000;
  return {
    watchdogDelayMs: Math.max(1_000, Math.min(50_000, deadlineSafetyMs)),
    pageLoadTimeoutMs: Math.max(1_000, Math.min(primaryFinalTimeoutMs, deadlineSafetyMs))
  };
}
