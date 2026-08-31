export const DISCOVERY_RETRY_DELAYS_MS = Object.freeze([
  2 * 60_000,
  5 * 60_000,
  15 * 60_000
]);

export function discoveryRetryDelay(failureCount) {
  const count = Math.max(1, Math.trunc(Number(failureCount) || 1));
  return DISCOVERY_RETRY_DELAYS_MS[Math.min(count - 1, DISCOVERY_RETRY_DELAYS_MS.length - 1)];
}

export function discoveryTabError(error, stage, extra = {}) {
  const tagged = new Error(String(error?.message || error || "The discovery tab failed"), { cause: error });
  tagged.discoveryTabFailure = true;
  tagged.discoveryStage = String(stage || "discovery_tab");
  Object.assign(tagged, extra);
  return tagged;
}

export function isDiscoveryTabFailure(error) {
  return error?.discoveryTabFailure === true;
}

export function tabBelongsToVenue(tab, venue) {
  const candidates = [tab?.pendingUrl, tab?.url].filter(Boolean);
  return candidates.some((value) => {
    try {
      const url = new URL(value);
      if (venue?.platform === "ticketnew") {
        return url.hostname.endsWith("ticketnew.com") && url.pathname.endsWith(`/${venue.cinemaId}`);
      }
      return url.hostname === "in.bookmyshow.com" && url.pathname.includes(`/${venue?.venueCode}/`);
    } catch {
      return false;
    }
  });
}
