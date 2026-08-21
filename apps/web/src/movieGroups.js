function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-IN")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function movieGroupKey(show) {
  return [show.movieTitle, show.language, show.format].map(normalize).join("|");
}

export function groupShowsByMovie(shows = []) {
  const groups = new Map();

  for (const show of shows) {
    const key = movieGroupKey(show);
    const group = groups.get(key) || {
      key,
      movieTitle: show.movieTitle || "Movie details unavailable",
      language: show.language || "",
      format: show.format || "",
      shows: [],
      capturedShows: 0,
      finalizedShows: 0,
      missedShows: 0,
      pendingShows: 0,
      ticketsSold: 0,
      collectionPaise: 0,
      capacity: 0,
      earliestStartAt: show.startAt || null
    };

    group.shows.push(show);
    if (!group.earliestStartAt || (show.startAt && show.startAt < group.earliestStartAt)) {
      group.earliestStartAt = show.startAt;
    }

    if (show.snapshot) {
      group.capturedShows += 1;
      group.ticketsSold += Number(show.snapshot.sold || 0);
      group.collectionPaise += Number(show.snapshot.collectionPaise || 0);
      group.capacity += Number(show.snapshot.capacity || 0);
    }

    if (show.status === "completed" && show.snapshot) group.finalizedShows += 1;
    if (show.status === "missed") group.missedShows += 1;
    if (!show.snapshot && ["scheduled", "capturing"].includes(show.status)) group.pendingShows += 1;

    groups.set(key, group);
  }

  return Array.from(groups.values()).map((group) => ({
    ...group,
    occupancyPercent: group.capacity
      ? Number(((group.ticketsSold / group.capacity) * 100).toFixed(2))
      : 0,
    shows: group.shows.slice().sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)))
  }));
}

export function sortMovieGroups(groups, sortBy) {
  const sorted = groups.slice();
  const byName = (a, b) => a.movieTitle.localeCompare(b.movieTitle, "en-IN", { sensitivity: "base" });

  sorted.sort((a, b) => {
    if (sortBy === "tickets") return b.ticketsSold - a.ticketsSold || byName(a, b);
    if (sortBy === "earliest") return String(a.earliestStartAt).localeCompare(String(b.earliestStartAt)) || byName(a, b);
    if (sortBy === "name") return byName(a, b);
    return b.collectionPaise - a.collectionPaise || b.ticketsSold - a.ticketsSold || byName(a, b);
  });

  return sorted;
}
