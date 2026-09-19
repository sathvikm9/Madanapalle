export const TODAY_REFRESH_INTERVAL_MS = 60_000;

export function shouldAutoRefreshDashboard({ selectedDate, latestDate, visibilityState }) {
  return selectedDate === latestDate && visibilityState === "visible";
}
