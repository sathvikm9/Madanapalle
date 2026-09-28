import { buildPushPayload } from "@block65/webcrypto-web-push";
import {
  buildDailySummaryNotification,
  buildPeriodNotification,
  DEFAULT_NOTIFICATION_TYPES,
  showPeriod
} from "@skct/core";
import { RequestError } from "./logic.js";
import { publicVenues, venueForCode } from "./venues.js";

const ALLOWED_TYPES = new Set(DEFAULT_NOTIFICATION_TYPES);
const TERMINAL_SHOW_STATUSES = new Set(["completed", "missed"]);

function indiaDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function allowedVenueCodes() {
  return publicVenues().filter((venue) => venue.code !== "ALL").map((venue) => venue.code);
}

function normalizePreferences(value = {}) {
  const allowedVenues = new Set(allowedVenueCodes());
  const venues = [...new Set(Array.isArray(value.venues) ? value.venues.map(String) : allowedVenueCodes())]
    .filter((venue) => allowedVenues.has(venue));
  const types = [...new Set(Array.isArray(value.types) ? value.types.map(String) : DEFAULT_NOTIFICATION_TYPES)]
    .filter((type) => ALLOWED_TYPES.has(type));
  if (!venues.length) throw new RequestError("Select at least one theatre for notifications");
  if (!types.length) throw new RequestError("Select at least one notification type");
  return { venues, types };
}

function normalizeSubscription(body) {
  const subscription = body?.subscription;
  const endpoint = String(subscription?.endpoint || "").trim();
  const p256dh = String(subscription?.keys?.p256dh || "").trim();
  const auth = String(subscription?.keys?.auth || "").trim();
  if (!endpoint.startsWith("https://") || endpoint.length > 2000) {
    throw new RequestError("A valid HTTPS push subscription endpoint is required");
  }
  if (!p256dh || p256dh.length > 300 || !auth || auth.length > 200) {
    throw new RequestError("The push subscription keys are invalid");
  }
  const expiration = subscription.expirationTime == null ? null : new Date(subscription.expirationTime);
  if (expiration && !Number.isFinite(expiration.getTime())) {
    throw new RequestError("The push subscription expiration is invalid");
  }
  return {
    endpoint,
    p256dh,
    auth,
    expirationTime: expiration?.toISOString() || null,
    deviceName: String(body?.deviceName || "MPLTalkies device").trim().slice(0, 80),
    preferences: normalizePreferences(body?.preferences)
  };
}

export function notificationConfig(env) {
  const publicKey = String(env.VAPID_PUBLIC_KEY || "").trim();
  return {
    available: Boolean(publicKey && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT),
    publicKey,
    venues: publicVenues().filter((venue) => venue.code !== "ALL").map((venue) => ({
      code: venue.code,
      name: venue.shortName
    })),
    types: DEFAULT_NOTIFICATION_TYPES
  };
}

export async function savePushSubscription(db, body, now = new Date()) {
  const value = normalizeSubscription(body);
  const timestamp = now.toISOString();
  await db.prepare(
    `INSERT INTO push_subscriptions (
       endpoint, p256dh, auth, expiration_time, device_name, venues_json, types_json,
       enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh=excluded.p256dh,
       auth=excluded.auth,
       expiration_time=excluded.expiration_time,
       device_name=excluded.device_name,
       venues_json=excluded.venues_json,
       types_json=excluded.types_json,
       enabled=1,
       updated_at=excluded.updated_at,
       last_error=NULL,
       failure_count=0`
  ).bind(
    value.endpoint,
    value.p256dh,
    value.auth,
    value.expirationTime,
    value.deviceName,
    JSON.stringify(value.preferences.venues),
    JSON.stringify(value.preferences.types),
    timestamp,
    timestamp
  ).run();
  return { ok: true, preferences: value.preferences };
}

export async function deletePushSubscription(db, body) {
  const endpoint = String(body?.endpoint || "").trim();
  if (!endpoint.startsWith("https://") || endpoint.length > 2000) {
    throw new RequestError("A valid push subscription endpoint is required");
  }
  await db.prepare(`DELETE FROM push_subscriptions WHERE endpoint=?`).bind(endpoint).run();
  return { ok: true };
}

async function notificationShows(db, showDate) {
  const result = await db.prepare(
    `SELECT shows.id, shows.venue_code, shows.venue_name, shows.show_date,
      shows.show_time_label, shows.start_at, shows.cutoff_at, shows.movie_title,
      shows.status, shows.updated_at,
      snapshots.sold, snapshots.collection_paise, snapshots.captured_at
     FROM shows
     LEFT JOIN snapshots ON snapshots.id=(
       SELECT latest.id FROM snapshots latest
       WHERE latest.show_id=shows.id AND latest.is_final=1
       ORDER BY latest.captured_at DESC LIMIT 1
     )
     WHERE shows.show_date=? AND shows.is_current=1
     ORDER BY shows.start_at ASC, shows.venue_code ASC`
  ).bind(showDate).all();
  return (result.results || []).map((row) => ({
    id: String(row.id),
    venueCode: row.venue_code,
    venueName: row.venue_name,
    venueShortName: venueForCode(row.venue_code)?.shortName || row.venue_code,
    showDate: row.show_date,
    showTime: row.show_time_label,
    startAt: row.start_at,
    cutoffAt: row.cutoff_at,
    movieTitle: row.movie_title,
    status: row.status,
    updatedAt: row.updated_at,
    snapshot: row.captured_at ? {
      sold: Number(row.sold),
      collectionPaise: Number(row.collection_paise),
      capturedAt: row.captured_at
    } : null
  }));
}

async function queueDelivery(db, subscriptionId, notificationKey, notificationType, payload, now) {
  await db.prepare(
    `INSERT OR IGNORE INTO push_deliveries (
       subscription_id, notification_key, notification_type, payload_json, status, created_at
     ) VALUES (?, ?, ?, ?, 'pending', ?)`
  ).bind(subscriptionId, notificationKey, notificationType, JSON.stringify(payload), now.toISOString()).run();
}

function subscriptionPreferences(row) {
  return normalizePreferences({
    venues: parseJson(row.venues_json, allowedVenueCodes()),
    types: parseJson(row.types_json, DEFAULT_NOTIFICATION_TYPES)
  });
}

function terminal(shows) {
  return shows.length > 0 && shows.every((show) => TERMINAL_SHOW_STATUSES.has(show.status));
}

function completedAfterSubscription(shows, createdAt) {
  const subscriptionTime = new Date(createdAt).getTime();
  return shows.some((show) => new Date(show.cutoffAt || show.updatedAt).getTime() >= subscriptionTime);
}

function deepLink(showDate, venues) {
  const venue = venues.length === 1 ? venues[0] : "ALL";
  return `?date=${encodeURIComponent(showDate)}&venue=${encodeURIComponent(venue)}`;
}

async function queuePeriodAndDailyNotifications(db, subscription, shows, now) {
  const preferences = subscriptionPreferences(subscription);
  const selected = shows.filter((show) => preferences.venues.includes(show.venueCode));
  if (!selected.length) return;
  const byPeriod = new Map();
  for (const show of selected) {
    const period = showPeriod(show.showTime);
    if (!byPeriod.has(period.key)) byPeriod.set(period.key, []);
    byPeriod.get(period.key).push(show);
  }

  if (preferences.types.includes("period_results")) {
    for (const [periodKey, periodShows] of byPeriod) {
      if (!terminal(periodShows) || !completedAfterSubscription(periodShows, subscription.created_at)) continue;
      const message = buildPeriodNotification(periodShows);
      await queueDelivery(db, subscription.id, `period:${shows[0].showDate}:${periodKey}`, "period_results", {
        ...message,
        tag: `period-${shows[0].showDate}-${periodKey}`,
        url: deepLink(shows[0].showDate, preferences.venues)
      }, now);
    }
  }

  if (preferences.types.includes("daily_summary") && terminal(selected) && completedAfterSubscription(selected, subscription.created_at)) {
    const allVenuesSelected = preferences.venues.length === allowedVenueCodes().length;
    const theatreLabel = allVenuesSelected
      ? "All theatres"
      : preferences.venues.length === 1
        ? venueForCode(preferences.venues[0])?.shortName || preferences.venues[0]
        : `${preferences.venues.length} theatres`;
    const message = buildDailySummaryNotification({
      showDate: shows[0].showDate,
      theatreLabel,
      shows: selected
    });
    await queueDelivery(db, subscription.id, `daily:${shows[0].showDate}`, "daily_summary", {
      ...message,
      tag: `daily-${shows[0].showDate}`,
      url: deepLink(shows[0].showDate, preferences.venues)
    }, now);
  }
}

async function queueScheduleNotifications(db, subscription, now) {
  const preferences = subscriptionPreferences(subscription);
  if (!preferences.types.includes("schedule_changes")) return;
  const events = await db.prepare(
    `SELECT events.id, events.venue_code, events.show_date, events.observed_at,
      previous.show_time_label AS previous_time, previous.movie_title AS previous_movie,
      next_show.show_time_label AS next_time, next_show.movie_title AS next_movie
     FROM schedule_events events
     JOIN shows previous ON previous.id=events.previous_show_id
     JOIN shows next_show ON next_show.id=events.next_show_id
     WHERE events.event_type='replaced' AND events.observed_at >= ?
     ORDER BY events.observed_at ASC`
  ).bind(subscription.created_at).all();

  for (const event of events.results || []) {
    if (!preferences.venues.includes(event.venue_code)) continue;
    const venue = venueForCode(event.venue_code)?.shortName || event.venue_code;
    await queueDelivery(db, subscription.id, `schedule:${event.id}`, "schedule_changes", {
      title: "Schedule change",
      body: `${venue} · ${event.previous_time} ${event.previous_movie} changed to ${event.next_time} ${event.next_movie}`,
      tag: `schedule-${event.id}`,
      url: deepLink(event.show_date, preferences.venues)
    }, now);
  }
}

async function sendPendingDeliveries(db, env, now) {
  const pending = await db.prepare(
    `SELECT deliveries.*, subscriptions.endpoint, subscriptions.p256dh, subscriptions.auth
     FROM push_deliveries deliveries
     JOIN push_subscriptions subscriptions ON subscriptions.id=deliveries.subscription_id
     WHERE deliveries.status='pending' AND deliveries.attempts < 10 AND subscriptions.enabled=1
     ORDER BY deliveries.created_at ASC LIMIT 100`
  ).all();
  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY
  };

  for (const delivery of pending.results || []) {
    const attemptedAt = now.toISOString();
    try {
      const payload = JSON.parse(delivery.payload_json);
      const request = await buildPushPayload({
        data: payload,
        options: { ttl: 60 * 60, urgency: delivery.notification_type === "schedule_changes" ? "high" : "normal" }
      }, {
        endpoint: delivery.endpoint,
        expirationTime: null,
        keys: { p256dh: delivery.p256dh, auth: delivery.auth }
      }, vapid);
      const response = await fetch(delivery.endpoint, request);
      if (!response.ok) throw Object.assign(new Error(`Push service returned ${response.status}`), { status: response.status });
      await db.batch([
        db.prepare(
          `UPDATE push_deliveries SET status='sent', attempts=attempts+1,
             last_attempt_at=?, sent_at=?, error=NULL WHERE id=?`
        ).bind(attemptedAt, attemptedAt, delivery.id),
        db.prepare(
          `UPDATE push_subscriptions SET last_success_at=?, last_error=NULL,
             failure_count=0, updated_at=? WHERE id=?`
        ).bind(attemptedAt, attemptedAt, delivery.subscription_id)
      ]);
    } catch (error) {
      const gone = error?.status === 404 || error?.status === 410;
      const message = String(error?.message || error).slice(0, 500);
      await db.batch([
        db.prepare(
          `UPDATE push_deliveries SET status=CASE WHEN ? THEN 'expired' ELSE status END,
             attempts=attempts+1, last_attempt_at=?, error=? WHERE id=?`
        ).bind(gone ? 1 : 0, attemptedAt, message, delivery.id),
        db.prepare(
          `UPDATE push_subscriptions SET enabled=CASE WHEN ? THEN 0 ELSE enabled END,
             last_error=?, failure_count=failure_count+1, updated_at=? WHERE id=?`
        ).bind(gone ? 1 : 0, message, attemptedAt, delivery.subscription_id)
      ]);
    }
  }
}

export async function dispatchNotifications(db, env, now = new Date()) {
  if (!notificationConfig(env).available) return { queued: 0, available: false };
  const subscriptions = await db.prepare(
    `SELECT * FROM push_subscriptions WHERE enabled=1 ORDER BY id ASC`
  ).all();
  if (!subscriptions.results?.length) return { queued: 0, available: true };
  const showDate = indiaDate(now);
  const shows = await notificationShows(db, showDate);
  for (const subscription of subscriptions.results) {
    if (shows.length) await queuePeriodAndDailyNotifications(db, subscription, shows, now);
    await queueScheduleNotifications(db, subscription, now);
  }
  await sendPendingDeliveries(db, env, now);
  return { subscriptions: subscriptions.results.length, available: true };
}
