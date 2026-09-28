export const SCHEDULE_REPLACEMENT_WINDOW_MS = 60 * 60 * 1000;

function showStart(show) {
  const value = show?.startAt ?? show?.start_at;
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
