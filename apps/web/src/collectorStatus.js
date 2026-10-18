export function collectorRelativeTime(lastSeenAt, now = new Date()) {
  const seenAt = new Date(lastSeenAt || "").getTime();
  if (!Number.isFinite(seenAt)) return "an unknown time";
  const minutes = Math.max(0, Math.floor((now.getTime() - seenAt) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "1 hour ago";
  return `${hours} hours ago`;
}

export function collectorIndicatorLabel(health) {
  if (health?.status === "online") return "Collector online";
  if (health?.status === "offline") return "Collector offline";
  if (health?.status === "idle") return "Collector resting";
  return "Automatic backup + final capture";
}

export function collectorOfflineMessage(health, now = new Date()) {
  if (health?.status !== "offline") return null;
  return `Last seen ${collectorRelativeTime(health.lastSeenAt, now)}. Open the collector laptop and Chrome now.`;
}
