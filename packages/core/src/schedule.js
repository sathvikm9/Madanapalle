export const SCHEDULE_REPLACEMENT_WINDOW_MS = 60 * 60 * 1000;

function showStart(show) {
  const value = show?.startAt ?? show?.start_at;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function eventTime(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function shiftedReplacementPairs(existingShows, discoveredShows, windowMs) {
  const candidates = [];
  for (const previous of existingShows) {
    const previousStart = showStart(previous);
    if (previousStart == null) continue;
    for (const next of discoveredShows) {
      const nextStart = showStart(next);
      if (nextStart == null) continue;
      const difference = Math.abs(nextStart - previousStart);
      if (difference <= windowMs) candidates.push({ previous, next, difference });
    }
  }

  candidates.sort((left, right) => (
    left.difference - right.difference
    || showStart(left.previous) - showStart(right.previous)
    || showStart(left.next) - showStart(right.next)
  ));

  const usedExisting = new Set();
  const usedDiscovered = new Set();
  return candidates.filter(({ previous, next }) => {
    if (usedExisting.has(previous) || usedDiscovered.has(next)) return false;
    usedExisting.add(previous);
    usedDiscovered.add(next);
    return true;
  });
}

export function classifyScheduleChanges(
  existingShows,
  discoveredShows,
  { replacementWindowMs = SCHEDULE_REPLACEMENT_WINDOW_MS } = {}
) {
  const currentExisting = existingShows.filter((show) => show.isCurrent);
  const existingBySlot = new Map(currentExisting.map((show) => [show.slotKey, show]));
  const added = [];
  const unchanged = [];
  const replaced = [];
  const removed = [];
  const matchedExisting = new Set();
  const matchedDiscovered = new Set();

  for (const discovered of discoveredShows) {
    const existing = existingBySlot.get(discovered.slotKey);
    if (!existing) continue;
    matchedExisting.add(existing);
    matchedDiscovered.add(discovered);
    if (existing.naturalKey === discovered.naturalKey) unchanged.push({ existing, discovered });
    else replaced.push({ previous: existing, next: discovered });
  }

  const unmatchedExisting = currentExisting.filter((show) => !matchedExisting.has(show));
  const unmatchedDiscovered = discoveredShows.filter((show) => !matchedDiscovered.has(show));
  const shifted = shiftedReplacementPairs(unmatchedExisting, unmatchedDiscovered, replacementWindowMs);
  for (const change of shifted) {
    replaced.push({ previous: change.previous, next: change.next });
    matchedExisting.add(change.previous);
    matchedDiscovered.add(change.next);
  }

  added.push(...discoveredShows.filter((show) => !matchedDiscovered.has(show)));
  removed.push(...currentExisting.filter((show) => !matchedExisting.has(show)));

  return { added, unchanged, replaced, removed };
}

export function reconcileHistoricalScheduleChanges(
  events,
  { replacementWindowMs = SCHEDULE_REPLACEMENT_WINDOW_MS } = {}
) {
  const replacements = events.filter((event) => event.type === "replaced");
  const representedPrevious = new Set(replacements.map((event) => event.previousShowId && String(event.previousShowId)).filter(Boolean));
  const representedNext = new Set(replacements.map((event) => event.nextShowId && String(event.nextShowId)).filter(Boolean));
  const removals = events.filter((event) => (
    event.type === "removed" && !representedPrevious.has(String(event.previousShowId))
  ));
  const additions = events.filter((event) => (
    event.type === "added" && !representedNext.has(String(event.nextShowId))
  ));
  const candidates = [];

  for (const removal of removals) {
    const previousStart = eventTime(removal.previousStartAt);
    const removedAt = eventTime(removal.observedAt);
    if (previousStart == null || removedAt == null) continue;
    for (const addition of additions) {
      if (addition.venueCode !== removal.venueCode || addition.showDate !== removal.showDate) continue;
      const nextStart = eventTime(addition.nextStartAt);
      const addedAt = eventTime(addition.observedAt);
      if (nextStart == null || addedAt == null || addedAt < removedAt) continue;
      const showtimeDifference = Math.abs(nextStart - previousStart);
      if (showtimeDifference > replacementWindowMs) continue;
      candidates.push({
        removal,
        addition,
        showtimeDifference,
        observationDelay: addedAt - removedAt
      });
    }
  }

  candidates.sort((left, right) => (
    left.showtimeDifference - right.showtimeDifference
    || left.observationDelay - right.observationDelay
    || String(left.removal.id).localeCompare(String(right.removal.id))
    || String(left.addition.id).localeCompare(String(right.addition.id))
  ));

  const pairedRemovals = new Set();
  const pairedAdditions = new Set();
  const reconstructed = [];
  for (const { removal, addition } of candidates) {
    if (pairedRemovals.has(removal) || pairedAdditions.has(addition)) continue;
    pairedRemovals.add(removal);
    pairedAdditions.add(addition);
    reconstructed.push({
      ...removal,
      id: `historical:${removal.id}:${addition.id}`,
      type: "replaced",
      nextShowId: addition.nextShowId,
      nextShowTime: addition.nextShowTime,
      nextMovie: addition.nextMovie,
      nextStartAt: addition.nextStartAt,
      observedAt: addition.observedAt,
      reconstructed: true
    });
  }

  return [
    ...replacements,
    ...removals.filter((event) => !pairedRemovals.has(event)),
    ...reconstructed
  ].sort((left, right) => eventTime(right.observedAt) - eventTime(left.observedAt));
}
