const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
}).format(new Date());

export function demoDashboard(date = today) {
  const base = `${date}T`;
  return {
    date,
    timezone: "Asia/Kolkata",
    venue: { code: "SKMD", name: "Sri Krishna A/C 4K Dolby Atmos: Madanapalle" },
    generatedAt: new Date().toISOString(),
    summary: {
      totalShows: 4, finalizedShows: 2, pendingShows: 2, missedShows: 0,
      ticketsSold: 183, collectionPaise: 1778500, capacity: 1314, occupancyPercent: 13.93
    },
    shows: [
      makeShow("1", "11:00 AM", `${base}11:00:00+05:30`, "Vishwanath and Sons", "completed", 103, 657, 1000000),
      makeShow("2", "02:10 PM", `${base}14:10:00+05:30`, "Vishwanath and Sons", "completed", 80, 657, 778500),
      makeShow("3", "06:00 PM", `${base}18:00:00+05:30`, "Vishwanath and Sons", "scheduled"),
      makeShow("4", "09:10 PM", `${base}21:10:00+05:30`, "Vishwanath and Sons", "scheduled")
    ],
    scheduleChanges: []
  };
}

function makeShow(id, time, startAt, movieTitle, status, sold = 0, capacity = 0, collectionPaise = 0) {
  const start = new Date(startAt);
  const cutoff = new Date(start.getTime() + 15 * 60_000);
  const captured = new Date(start.getTime() + 14 * 60_000 + 38_000);
  return {
    id, sessionId: `62${id}0`, movieTitle, language: "Telugu", format: "2D", showTime: time,
    startAt, captureDueAt: new Date(start.getTime() + 14 * 60_000).toISOString(),
    cutoffAt: cutoff.toISOString(), isCurrent: true, status, captureAttempts: status === "completed" ? 3 : 0,
    advertisedCategories: [
      { name: "RESERVED CLASS", listPricePaise: 10500 },
      { name: "SECOND CLASS", listPricePaise: 8400 }
    ],
    snapshot: status === "completed" ? {
      capturedAt: captured.toISOString(), capacity, available: capacity - sold, sold, unknown: 0,
      collectionPaise, occupancyPercent: Number(((sold / capacity) * 100).toFixed(2)), isFinal: true,
      categories: [
        { name: "RESERVED CLASS", listPricePaise: 10500, netPricePaise: 10000, sold: Math.max(sold - 12, 0), capacity: 493, collectionPaise: Math.max(sold - 12, 0) * 10000 },
        { name: "SECOND CLASS", listPricePaise: 8400, netPricePaise: 7900, sold: Math.min(sold, 12), capacity: 164, collectionPaise: Math.min(sold, 12) * 7900 }
      ]
    } : null
  };
}
