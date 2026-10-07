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
const DAILY_SUMMARY_GAP_MS = 60_000;
const MAX_EVENT_ATTEMPTS = 10;
const MAX_DELIVERY_ATTEMPTS = 10;

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

function normalizeInstallationId(value) {
  const installationId = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(installationId)) {
    throw new RequestError("A valid PWA installation ID is required");
  }
  return installationId;
}

function normalizePlatform(value) {
  const platform = String(value || "web").trim().toLowerCase();
  return new Set(["ios", "android", "web"]).has(platform) ? platform : "web";
}

function normalizeInstallSource(value) {
  const source = String(value || "standalone_launch").trim().toLowerCase();
  return new Set(["appinstalled", "standalone_launch", "notifications"]).has(source)
    ? source
    : "standalone_launch";
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
    installationId: normalizeInstallationId(body?.installationId),
    platform: normalizePlatform(body?.platform),
    deviceName: String(body?.deviceName || "MPLTalkies device").trim().slice(0, 80),
    preferences: normalizePreferences(body?.preferences)
  };
}

export function notificationConfig(env) {
  const enabled = String(env.NOTIFICATIONS_ENABLED || "").toLowerCase() === "true";
  const publicKey = String(env.VAPID_PUBLIC_KEY || "").trim();
  return {
    available: Boolean(enabled && publicKey && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT),
    publicKey,
    venues: publicVenues().filter((venue) => venue.code !== "ALL").map((venue) => ({
      code: venue.code,
      name: venue.shortName
    })),
    types: DEFAULT_NOTIFICATION_TYPES
  };
}

export async function recordPwaInstallation(db, body, now = new Date()) {
  const installationId = normalizeInstallationId(body?.installationId);
  const platform = normalizePlatform(body?.platform);
  const source = normalizeInstallSource(body?.source);
  const timestamp = now.toISOString();
  await db.prepare(
    `INSERT INTO pwa_installations (
       installation_id, platform, install_source, installed_at, first_seen_at, last_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(installation_id) DO UPDATE SET
       platform=excluded.platform,
       install_source=CASE
         WHEN pwa_installations.install_source='appinstalled' THEN pwa_installations.install_source
         ELSE excluded.install_source
       END,
       last_seen_at=excluded.last_seen_at`
  ).bind(installationId, platform, source, timestamp, timestamp, timestamp).run();
  return { ok: true };
}

export async function adoptionStats(db) {
  const stats = await db.prepare(
    `SELECT
       COUNT(*) AS installed_pwas,
       SUM(CASE WHEN notification_enabled=1 THEN 1 ELSE 0 END) AS notifications_enabled
     FROM pwa_installations`
  ).first();
  return {
    installedPwas: Number(stats?.installed_pwas || 0),
    notificationsEnabled: Number(stats?.notifications_enabled || 0)
  };
}

export async function savePushSubscription(db, body, now = new Date()) {
  const value = normalizeSubscription(body);
  const timestamp = now.toISOString();
  const existing = await db.prepare(
    `SELECT id FROM push_subscriptions
     WHERE installation_id=? OR endpoint=?
     ORDER BY CASE WHEN installation_id=? THEN 0 ELSE 1 END, id DESC
     LIMIT 1`
  ).bind(value.installationId, value.endpoint, value.installationId).first();

  const statements = [];
  if (existing?.id) {
    statements.push(
      db.prepare(
        `DELETE FROM push_subscriptions
         WHERE (installation_id=? OR endpoint=?) AND id<>?`
      ).bind(value.installationId, value.endpoint, existing.id),
      db.prepare(
        `UPDATE push_subscriptions SET
           endpoint=?, p256dh=?, auth=?, expiration_time=?, installation_id=?, device_name=?,
           venues_json=?, types_json=?, enabled=1, updated_at=?, last_error=NULL, failure_count=0
         WHERE id=?`
      ).bind(
        value.endpoint,
        value.p256dh,
        value.auth,
        value.expirationTime,
        value.installationId,
        value.deviceName,
        JSON.stringify(value.preferences.venues),
        JSON.stringify(value.preferences.types),
        timestamp,
        existing.id
      )
    );
  } else {
    statements.push(
      db.prepare(
        `INSERT INTO push_subscriptions (
           endpoint, p256dh, auth, expiration_time, installation_id, device_name,
           venues_json, types_json, enabled, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      ).bind(
        value.endpoint,
        value.p256dh,
        value.auth,
        value.expirationTime,
        value.installationId,
        value.deviceName,
        JSON.stringify(value.preferences.venues),
        JSON.stringify(value.preferences.types),
        timestamp,
        timestamp
      )
    );
  }
  statements.push(
    db.prepare(
      `INSERT INTO pwa_installations (
         installation_id, platform, install_source, installed_at, first_seen_at, last_seen_at,
         notification_enabled, notification_enabled_at
       ) VALUES (?, ?, 'notifications', ?, ?, ?, 1, ?)
       ON CONFLICT(installation_id) DO UPDATE SET
         platform=excluded.platform,
         last_seen_at=excluded.last_seen_at,
         notification_enabled=1,
         notification_enabled_at=COALESCE(pwa_installations.notification_enabled_at, excluded.notification_enabled_at),
         notification_disabled_at=NULL`
    ).bind(value.installationId, value.platform, timestamp, timestamp, timestamp, timestamp)
  );
  await db.batch(statements);
  return { ok: true, preferences: value.preferences };
}

export async function deletePushSubscription(db, body, now = new Date()) {
  const endpoint = String(body?.endpoint || "").trim();
  if (!endpoint.startsWith("https://") || endpoint.length > 2000) {
    throw new RequestError("A valid push subscription endpoint is required");
  }
  const installationId = body?.installationId
    ? normalizeInstallationId(body.installationId)
    : null;
  const timestamp = now.toISOString();
  const statements = [
    db.prepare(`DELETE FROM push_subscriptions WHERE endpoint=?`).bind(endpoint)
  ];
  if (installationId) {
    statements.push(
      db.prepare(
        `UPDATE pwa_installations SET notification_enabled=0,
          notification_disabled_at=?, last_seen_at=? WHERE installation_id=?`
      ).bind(timestamp, timestamp, installationId)
    );
  }
  await db.batch(statements);
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

function latestTerminalTime(shows) {
  return Math.max(...shows.map((show) => new Date(
    show.updatedAt || show.snapshot?.capturedAt || show.cutoffAt
  ).getTime()).filter(Number.isFinite));
}

function deliveryStatement(db, subscriptionId, key, type, payload, dueAt, now) {
  return db.prepare(
    `INSERT OR IGNORE INTO push_deliveries (
       subscription_id, notification_key, notification_type, payload_json,
       status, due_at, next_attempt_at, created_at
     ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`
  ).bind(
    subscriptionId,
    key,
    type,
    JSON.stringify(payload),
    dueAt,
    dueAt,
    now.toISOString()
  );
}

function dateDeliveryStatements(db, subscriptions, shows, showDate, now) {
  const statements = [];
  for (const subscription of subscriptions) {
    const preferences = subscriptionPreferences(subscription);
    const selected = shows.filter((show) => preferences.venues.includes(show.venueCode));
    if (!selected.length || !completedAfterSubscription(selected, subscription.created_at)) continue;

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
        statements.push(deliveryStatement(
          db,
          subscription.id,
          `period:${showDate}:${periodKey}`,
          "period_results",
          {
            ...message,
            tag: `period-${showDate}-${periodKey}`,
            url: deepLink(showDate, preferences.venues)
          },
          now.toISOString(),
          now
        ));
      }
    }

    if (preferences.types.includes("daily_summary") && terminal(selected)) {
      const allVenuesSelected = preferences.venues.length === allowedVenueCodes().length;
      const theatreLabel = allVenuesSelected
        ? "All theatres"
        : preferences.venues.length === 1
          ? venueForCode(preferences.venues[0])?.shortName || preferences.venues[0]
          : `${preferences.venues.length} theatres`;
      const message = buildDailySummaryNotification({ showDate, theatreLabel, shows: selected });
      const completedAt = latestTerminalTime(selected);
      const dueAt = new Date(Math.max(now.getTime(), completedAt + DAILY_SUMMARY_GAP_MS)).toISOString();
      statements.push(deliveryStatement(
        db,
        subscription.id,
        `daily:${showDate}`,
        "daily_summary",
        {
          ...message,
          tag: `daily-${showDate}`,
          url: deepLink(showDate, preferences.venues)
        },
        dueAt,
        now
      ));
    }
  }
  return statements;
}

function scheduleDeliveryStatements(db, subscriptions, event, now) {
  const payload = parseJson(event.payload_json, {});
  const venueCode = event.venue_code || payload.venueCode;
  const venue = venueForCode(venueCode)?.shortName || venueCode;
  const statements = [];
  for (const subscription of subscriptions) {
    const preferences = subscriptionPreferences(subscription);
    if (!preferences.types.includes("schedule_changes") || !preferences.venues.includes(venueCode)) continue;
    statements.push(deliveryStatement(
      db,
      subscription.id,
      event.event_key,
      "schedule_changes",
      {
        title: "Schedule change",
        body: `${venue} · ${payload.previousTime} ${payload.previousMovie} changed to ${payload.nextTime} ${payload.nextMovie}`,
        tag: event.event_key,
        url: deepLink(event.show_date, preferences.venues)
      },
      now.toISOString(),
      now
    ));
  }
  return statements;
}

function captureAlertDeliveryStatements(db, subscriptions, event, now) {
  const payload = parseJson(event.payload_json, {});
  const venueCode = event.venue_code || payload.venueCode;
  const venue = venueForCode(venueCode)?.shortName || venueCode;
  const finalFailure = payload.alertPhase === "final";
  const showTime = String(payload.showTime || "").replace(/^0(?=\d:)/, "");
  const title = finalFailure
    ? `${venue} ${showTime} final capture failed`
    : `${venue} ${showTime} capture failed - CHECK NOW`;
  const body = finalFailure
    ? `${payload.movieTitle || "Booking-site capture"}\nNo protected backup is available.`
    : `${payload.movieTitle || "Booking-site capture"}\nAutomatic recovery is continuing.`;
  const statements = [];
  for (const subscription of subscriptions) {
    const preferences = subscriptionPreferences(subscription);
    if (!preferences.venues.includes(venueCode)) continue;
    statements.push(deliveryStatement(
      db,
      subscription.id,
      event.event_key,
      "capture_alert",
      {
        title,
        body,
        tag: event.event_key,
        url: deepLink(event.show_date, preferences.venues)
      },
      now.toISOString(),
      now
    ));
  }
  return statements;
}

export async function processNotificationEvents(db, env, now = new Date()) {
  if (!notificationConfig(env).available) return { processed: 0, queued: 0, available: false };
  const timestamp = now.toISOString();
  const pending = await db.prepare(
    `SELECT id, event_key, event_type, show_date, venue_code, payload_json
     FROM notification_events
     WHERE status='pending' AND due_at<=? AND attempts<?
     ORDER BY due_at ASC, id ASC LIMIT 100`
  ).bind(timestamp, MAX_EVENT_ATTEMPTS).all();
  const events = pending.results || [];
  if (!events.length) return { processed: 0, queued: 0, available: true };

  const subscriptionsResult = await db.prepare(
    `SELECT * FROM push_subscriptions WHERE enabled=1 ORDER BY id ASC`
  ).all();
  const subscriptions = subscriptionsResult.results || [];
  const statements = [];
  const showDates = [...new Set(events
    .filter((event) => event.event_type === "show_finalized" && event.show_date)
    .map((event) => event.show_date))];
  for (const showDate of showDates) {
    const shows = await notificationShows(db, showDate);
    statements.push(...dateDeliveryStatements(db, subscriptions, shows, showDate, now));
  }
  for (const event of events.filter((candidate) => candidate.event_type === "schedule_change")) {
    statements.push(...scheduleDeliveryStatements(db, subscriptions, event, now));
  }
  for (const event of events.filter((candidate) => candidate.event_type === "capture_alert")) {
    statements.push(...captureAlertDeliveryStatements(db, subscriptions, event, now));
  }
  for (const event of events) {
    statements.push(
      db.prepare(
        `UPDATE notification_events SET status='processed', processed_at=?, error=NULL,
          attempts=attempts+1 WHERE id=?`
      ).bind(timestamp, event.id)
    );
  }
  if (statements.length) await db.batch(statements);
  return { processed: events.length, queued: statements.length - events.length, available: true };
}

function retryDelayMs(attempt) {
  if (attempt <= 1) return 60_000;
  if (attempt <= 3) return 5 * 60_000;
  return 15 * 60_000;
}

export async function sendPendingDeliveries(db, env, now = new Date()) {
  if (!notificationConfig(env).available) return { sent: 0, available: false };
  const timestamp = now.toISOString();
  const pending = await db.prepare(
    `SELECT deliveries.*, subscriptions.endpoint, subscriptions.p256dh, subscriptions.auth,
      subscriptions.installation_id
     FROM push_deliveries deliveries
     JOIN push_subscriptions subscriptions ON subscriptions.id=deliveries.subscription_id
     WHERE deliveries.status='pending' AND deliveries.attempts<? AND subscriptions.enabled=1
       AND deliveries.due_at<=? AND deliveries.next_attempt_at<=?
     ORDER BY deliveries.due_at ASC, deliveries.created_at ASC LIMIT 100`
  ).bind(MAX_DELIVERY_ATTEMPTS, timestamp, timestamp).all();
  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY
  };
  let sent = 0;

  for (const delivery of pending.results || []) {
    const attemptedAt = now.toISOString();
    try {
      const payload = JSON.parse(delivery.payload_json);
      const urgent = delivery.notification_type === "schedule_changes" ||
        delivery.notification_type === "capture_alert";
      const request = await buildPushPayload({
        data: payload,
        options: { ttl: urgent ? 15 * 60 : 60 * 60, urgency: urgent ? "high" : "normal" }
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
      sent += 1;
    } catch (error) {
      const gone = error?.status === 404 || error?.status === 410;
      const message = String(error?.message || error).slice(0, 500);
      const nextAttempt = new Date(now.getTime() + retryDelayMs(Number(delivery.attempts) + 1)).toISOString();
      const exhausted = Number(delivery.attempts) + 1 >= MAX_DELIVERY_ATTEMPTS;
      const statements = [
        db.prepare(
          `UPDATE push_deliveries SET status=CASE WHEN ? THEN 'expired' WHEN ? THEN 'failed' ELSE 'pending' END,
             attempts=attempts+1, last_attempt_at=?, next_attempt_at=?, error=? WHERE id=?`
        ).bind(gone ? 1 : 0, exhausted ? 1 : 0, attemptedAt, nextAttempt, message, delivery.id),
        db.prepare(
          `UPDATE push_subscriptions SET enabled=CASE WHEN ? THEN 0 ELSE enabled END,
             last_error=?, failure_count=failure_count+1, updated_at=? WHERE id=?`
        ).bind(gone ? 1 : 0, message, attemptedAt, delivery.subscription_id)
      ];
      if (gone && delivery.installation_id) {
        statements.push(
          db.prepare(
            `UPDATE pwa_installations SET notification_enabled=0,
              notification_disabled_at=?, last_seen_at=? WHERE installation_id=?`
          ).bind(attemptedAt, attemptedAt, delivery.installation_id)
        );
      }
      await db.batch(statements);
    }
  }
  return { sent, available: true };
}

export async function dispatchNotifications(db, env, now = new Date()) {
  if (!notificationConfig(env).available) return { queued: 0, sent: 0, available: false };
  const processed = await processNotificationEvents(db, env, now);
  const delivered = await sendPendingDeliveries(db, env, now);
  return {
    queued: processed.queued,
    processed: processed.processed,
    sent: delivered.sent,
    available: true
  };
}
