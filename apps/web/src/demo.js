const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
}).format(new Date());

const venues = [
  { code: "ALL", name: "All theatres", shortName: "All theatres" },
  { code: "SKMD", name: "Sri Krishna A/C 4K Dolby Atmos: Madanapalle", shortName: "Sri Krishna" },
  { code: "RTDM", name: "Ravi A/C 4K Laser Dolby Surround 7.1: Madanapalle", shortName: "Ravi" }
];

export function demoDashboard(date = today, venueCode = "ALL") {
  const base = `${date}T`;
  const allShows = [
    makeShow("1", "SKMD", "Sri Krishna", "11:00 AM", `${base}11:00:00+05:30`, "Vishwanath and Sons", "completed", 15, 103, 657, 1000000),
    makeShow("2", "SKMD", "Sri Krishna", "02:10 PM", `${base}14:10:00+05:30`, "Vishwanath and Sons", "completed", 15, 80, 657, 778500),
    makeShow("3", "SKMD", "Sri Krishna", "06:00 PM", `${base}18:00:00+05:30`, "Vishwanath and Sons", "scheduled", 15),
    makeShow("4", "SKMD", "Sri Krishna", "09:10 PM", `${base}21:10:00+05:30`, "Vishwanath and Sons", "scheduled", 15),
    makeShow("5", "RTDM", "Ravi", "11:00 AM", `${base}11:00:00+05:30`, "Vishwanath and Sons", "completed", 20, 126, 720, 1215800),
    makeShow("6", "RTDM", "Ravi", "02:20 PM", `${base}14:20:00+05:30`, "Vishwanath and Sons", "scheduled", 20),
    makeShow("7", "RTDM", "Ravi", "06:00 PM", `${base}18:00:00+05:30`, "Vishwanath and Sons", "scheduled", 20),
    makeShow("8", "RTDM", "Ravi", "09:20 PM", `${base}21:20:00+05:30`, "Vishwanath and Sons", "scheduled", 20)
  ];
  const shows = venueCode === "ALL" ? allShows : allShows.filter((show) => show.venueCode === venueCode);
  const finalized = shows.filter((show) => show.status === "completed" && show.snapshot);
  const totals = finalized.reduce((sum, show) => ({
    ticketsSold: sum.ticketsSold + show.snapshot.sold,
    collectionPaise: sum.collectionPaise + show.snapshot.collectionPaise,
    capacity: sum.capacity + show.snapshot.capacity
  }), { ticketsSold: 0, collectionPaise: 0, capacity: 0 });
  const venue = venues.find((item) => item.code === venueCode) || venues[0];
  return {
    date,
    timezone: "Asia/Kolkata",
    venue,
    venues,
    generatedAt: new Date().toISOString(),
    summary: {
      totalShows: shows.length,
      finalizedShows: finalized.length,
      pendingShows: shows.filter((show) => ["scheduled", "capturing"].includes(show.status)).length,
      missedShows: shows.filter((show) => show.status === "missed").length,
      ...totals,
      occupancyPercent: totals.capacity ? Number(((totals.ticketsSold / totals.capacity) * 100).toFixed(2)) : 0
    },
    shows,
    scheduleChanges: []
  };
}

function makeShow(id, venueCode, venueName, time, startAt, movieTitle, status, cutoffMinutes, sold = 0, capacity = 0, collectionPaise = 0) {
  const start = new Date(startAt);
  const cutoff = new Date(start.getTime() + cutoffMinutes * 60_000);
  const captured = new Date(cutoff.getTime() - 22_000);
  const reservedSold = Math.max(sold - 12, 0);
  const secondClassSold = Math.min(sold, 12);
  collectionPaise = reservedSold * 10000 + secondClassSold * 7900;
  return {
    id,
    venueCode,
    venueName,
    venueShortName: venueName,
    sessionId: `62${id}0`,
    movieTitle,
    language: "Telugu",
    format: "2D",
    showTime: time,
    startAt,
    captureDueAt: new Date(cutoff.getTime() - 60_000).toISOString(),
    cutoffAt: cutoff.toISOString(),
    isCurrent: true,
    status,
    captureAttempts: status === "completed" ? 1 : 0,
    advertisedCategories: [
      { name: "RESERVED CLASS", listPricePaise: 10500 },
      { name: "SECOND CLASS", listPricePaise: 8400 }
    ],
    snapshot: status === "completed" ? {
      capturedAt: captured.toISOString(),
      capacity,
      available: capacity - sold,
      sold,
      unknown: 0,
      collectionPaise,
      occupancyPercent: Number(((sold / capacity) * 100).toFixed(2)),
      isFinal: true,
      categories: [
        { name: "RESERVED CLASS", listPricePaise: 10500, netPricePaise: 10000, sold: reservedSold, capacity: Math.max(capacity - 164, 0), collectionPaise: reservedSold * 10000 },
        { name: "SECOND CLASS", listPricePaise: 8400, netPricePaise: 7900, sold: secondClassSold, capacity: Math.min(capacity, 164), collectionPaise: secondClassSold * 7900 }
      ]
    } : null
  };
}
