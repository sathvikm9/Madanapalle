export function classifyScheduleChanges(existingShows, discoveredShows) {
  const existingBySlot = new Map(existingShows.filter((show) => show.isCurrent).map((show) => [show.slotKey, show]));
  const discoveredBySlot = new Map(discoveredShows.map((show) => [show.slotKey, show]));
  const added = [];
  const unchanged = [];
  const replaced = [];
  const removed = [];

  for (const discovered of discoveredShows) {
    const existing = existingBySlot.get(discovered.slotKey);
    if (!existing) added.push(discovered);
    else if (existing.naturalKey === discovered.naturalKey) unchanged.push({ existing, discovered });
    else replaced.push({ previous: existing, next: discovered });
  }

  for (const existing of existingBySlot.values()) {
    if (!discoveredBySlot.has(existing.slotKey)) removed.push(existing);
  }

  return { added, unchanged, replaced, removed };
}
