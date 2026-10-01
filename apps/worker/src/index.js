import {
  captureHistory,
  currentShow,
  dashboardData,
  finalizeExpiredShows,
  recordCaptureEvent,
  recordMovieReleaseMetadata,
  reconcileDiscovery,
  saveCapture,
  showForCapture
} from "./database.js";
import { analyticsCatalog, analyticsSummary } from "./analytics.js";
import { interpretChatQuestion } from "./ai-chat.js";
import {
  normalizeCapture,
  normalizeDiscovery,
  RequestError,
  requiredString,
  validDate
} from "./logic.js";
import { dashboardVenueForCode, publicVenues } from "./venues.js";
import {
  adoptionStats,
  deletePushSubscription,
  dispatchNotifications,
  notificationConfig,
  recordPwaInstallation,
  savePushSubscription
} from "./notifications.js";

const DASHBOARD_CACHE_TTL_SECONDS = 45;

function allowedOrigin(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  if (origin.startsWith("chrome-extension://")) return origin;
  const configured = String(env.CORS_ORIGINS || "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
  if (configured.includes("*")) return "*";
  return configured.includes(origin.replace(/\/$/, "")) ? origin : false;
}

function corsHeaders(origin) {
  const headers = {
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
  if (origin) headers["access-control-allow-origin"] = origin;
  return headers;
}

function json(data, status = 200, origin = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...corsHeaders(origin)
    }
  });
}

async function bodyJson(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 65_536) throw new RequestError("Request body is too large", 413, "body_too_large");
  const text = await request.text();
  if (text.length > 65_536) throw new RequestError("Request body is too large", 413, "body_too_large");
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError("Request body must be valid JSON");
  }
}

function requireAgent(request, env) {
  if (!env.AGENT_TOKEN || request.headers.get("authorization") !== `Bearer ${env.AGENT_TOKEN}`) {
    throw new RequestError("Unauthorized", 401, "unauthorized");
  }
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function dashboardCacheRequest(date, venueCode) {
  const url = new URL("https://mpltalkies-dashboard-cache.invalid/api/dashboard");
  url.searchParams.set("date", date);
  url.searchParams.set("venueCode", venueCode);
  return new Request(url.toString(), { method: "GET" });
}

async function cachedDashboard(db, date, venueCode) {
  const cache = globalThis.caches?.default;
  const cacheKey = dashboardCacheRequest(date, venueCode);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit.json();
  }
  const data = await dashboardData(db, date, venueCode);
  if (cache) {
    await cache.put(cacheKey, new Response(JSON.stringify(data), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${DASHBOARD_CACHE_TTL_SECONDS}`
      }
    }));
  }
  return data;
}

async function invalidateDashboardCache(date, venueCode) {
  const cache = globalThis.caches?.default;
  if (!cache || !validDate(date)) return;
  await Promise.all([
    cache.delete(dashboardCacheRequest(date, venueCode)),
    cache.delete(dashboardCacheRequest(date, "ALL"))
  ]);
}

function runInBackground(context, promise, label) {
  const guarded = promise.catch((error) => console.error(label, error));
  if (context?.waitUntil) context.waitUntil(guarded);
  else void guarded;
}

async function route(request, env, origin, context) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    await env.DB.prepare("SELECT 1 AS ok").first();
    return json({
      ok: true,
      database: "connected",
      collector: "local-chrome-extension",
      venues: publicVenues().filter((venue) => venue.code !== "ALL"),
      now: new Date().toISOString()
    }, 200, origin);
  }

  if (request.method === "GET" && url.pathname === "/api/notifications/config") {
    return json(notificationConfig(env), 200, origin);
  }

  if (request.method === "POST" && url.pathname === "/api/installations") {
    if (!origin) throw new RequestError("An approved dashboard origin is required", 403, "origin_required");
    return json(await recordPwaInstallation(env.DB, await bodyJson(request)), 200, origin);
  }

  if (request.method === "GET" && url.pathname === "/api/adoption") {
    return json(await adoptionStats(env.DB), 200, origin);
  }

  if (request.method === "POST" && url.pathname === "/api/notifications/subscriptions") {
    if (!origin) throw new RequestError("An approved dashboard origin is required", 403, "origin_required");
    if (!notificationConfig(env).available) {
      throw new RequestError("Push notifications are not configured", 503, "notifications_unavailable");
    }
    return json(await savePushSubscription(env.DB, await bodyJson(request)), 200, origin);
  }

  if (request.method === "DELETE" && url.pathname === "/api/notifications/subscriptions") {
    if (!origin) throw new RequestError("An approved dashboard origin is required", 403, "origin_required");
    return json(await deletePushSubscription(env.DB, await bodyJson(request)), 200, origin);
  }

  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    const date = String(url.searchParams.get("date") || "");
    const venueCode = String(url.searchParams.get("venueCode") || "SKMD");
    if (!validDate(date)) throw new RequestError("date must be a real YYYY-MM-DD date");
    if (!dashboardVenueForCode(venueCode)) throw new RequestError(`Venue ${venueCode} is not configured`);
    return json(await cachedDashboard(env.DB, date, venueCode), 200, origin);
  }

  if (request.method === "GET" && url.pathname === "/api/analytics/catalog") {
    return json(await analyticsCatalog(env.DB), 200, origin);
  }

  if (request.method === "GET" && url.pathname === "/api/analytics/summary") {
    const movieTitle = requiredString(url.searchParams.get("movie"), "movie", 300);
    const venueCode = String(url.searchParams.get("venueCode") || "ALL");
    const startDate = String(url.searchParams.get("startDate") || "");
    const endDate = String(url.searchParams.get("endDate") || "");
    const completeDaysOnly = url.searchParams.get("completeDaysOnly") === "1";
    if (!dashboardVenueForCode(venueCode)) throw new RequestError(`Venue ${venueCode} is not configured`);
    if (!validDate(startDate) || !validDate(endDate)) {
      throw new RequestError("startDate and endDate must be real YYYY-MM-DD dates");
    }
    if (startDate > endDate) throw new RequestError("startDate must be on or before endDate");
    return json(await analyticsSummary(env.DB, { movieTitle, venueCode, startDate, endDate, completeDaysOnly }), 200, origin);
  }

  if (request.method === "POST" && url.pathname === "/api/analytics/interpret") {
    if (!origin) throw new RequestError("An approved dashboard origin is required", 403, "origin_required");
    const body = await bodyJson(request);
    const question = requiredString(body?.question, "question", 240);
    const catalog = await analyticsCatalog(env.DB);
    const interpretation = await interpretChatQuestion(env.AI, {
      question,
      context: body?.context,
      catalog,
      model: String(env.AI_MODEL || "").trim() || undefined
    });
    return json(interpretation, 200, origin);
  }

  const captureHistoryMatch = url.pathname.match(/^\/api\/shows\/(\d+)\/captures$/);
  if (request.method === "GET" && captureHistoryMatch) {
    return json(await captureHistory(env.DB, captureHistoryMatch[1]), 200, origin);
  }

  if (request.method === "POST" && url.pathname === "/api/agent/discovery") {
    requireAgent(request, env);
    const discovery = normalizeDiscovery(await bodyJson(request));
    const result = await reconcileDiscovery(env.DB, discovery);
    await invalidateDashboardCache(discovery.showDate, discovery.venueCode);
    runInBackground(
      context,
      dispatchNotifications(env.DB, env),
      "Schedule notification dispatch failed"
    );
    return json(result, 200, origin);
  }

  if (request.method === "POST" && url.pathname === "/api/agent/movie-release") {
    requireAgent(request, env);
    const body = await bodyJson(request);
    const movieKey = requiredString(body?.movieKey, "movieKey", 300);
    const provider = String(body?.provider || "bookmyshow").trim().toLowerCase();
    if (!new Set(["bookmyshow", "district"]).has(provider)) {
      throw new RequestError("provider must be bookmyshow or district");
    }
    const eventCode = requiredString(body?.eventCode, "eventCode", 50).toUpperCase();
    if (provider === "bookmyshow" && !/^ET\d+$/.test(eventCode)) {
      throw new RequestError("eventCode must be a BookMyShow movie code");
    }
    if (provider === "district" && !/^MV\d+$/.test(eventCode)) {
      throw new RequestError("eventCode must be a District movie code");
    }

    if (body?.releaseDate != null) {
      if (!validDate(body.releaseDate)) throw new RequestError("releaseDate must be a real YYYY-MM-DD date");
      const movieUrl = requiredString(body?.movieUrl, "movieUrl", 1_000);
      let parsedUrl;
      try {
        parsedUrl = new URL(movieUrl);
      } catch {
        throw new RequestError("movieUrl is invalid");
      }
      const isBookMyShow = parsedUrl.hostname === "in.bookmyshow.com" && parsedUrl.pathname.includes(`/${eventCode}`);
      const districtHost = parsedUrl.hostname === "district.in" || parsedUrl.hostname === "www.district.in" ||
        parsedUrl.hostname.endsWith(".district.in");
      const isDistrict = districtHost && parsedUrl.pathname.startsWith("/movies/") &&
        parsedUrl.pathname.toUpperCase().includes(`-${eventCode}`);
      if (parsedUrl.protocol !== "https:" || (provider === "bookmyshow" ? !isBookMyShow : !isDistrict)) {
        throw new RequestError(`movieUrl must be the matching ${provider === "bookmyshow" ? "BookMyShow" : "District"} movie page`);
      }
      return json(await recordMovieReleaseMetadata(env.DB, {
        movieKey,
        provider,
        eventCode,
        releaseDate: body.releaseDate,
        movieUrl: parsedUrl.toString(),
        canonicalTitle: body?.canonicalTitle ? requiredString(body.canonicalTitle, "canonicalTitle", 300) : null
      }), 200, origin);
    }

    return json(await recordMovieReleaseMetadata(env.DB, {
      movieKey,
      provider,
      eventCode,
      error: requiredString(body?.error, "error", 500)
    }), 200, origin);
  }

  if (request.method === "POST" && url.pathname === "/api/agent/capture") {
    requireAgent(request, env);
    const body = await bodyJson(request);
    const naturalKey = requiredString(body?.naturalKey, "naturalKey", 300);
    const show = await showForCapture(env.DB, naturalKey);
    const capture = normalizeCapture(body, show, new Date());
    if (!capture.rawHash) {
      capture.rawHash = await sha256(JSON.stringify({
        naturalKey: capture.naturalKey,
        capturedAt: capture.capturedAt,
        categories: capture.categories
      }));
    }
    const result = await saveCapture(env.DB, show, capture);
    await invalidateDashboardCache(show.show_date, show.venue_code);
    return json(result, 200, origin);
  }

  if (request.method === "POST" && url.pathname === "/api/agent/event") {
    requireAgent(request, env);
    const body = await bodyJson(request);
    const eventType = requiredString(body?.eventType, "eventType", 50);
    if (!new Set(["capture_started", "capture_failed"]).has(eventType)) {
      throw new RequestError("eventType is not supported");
    }
    const naturalKey = requiredString(body?.naturalKey, "naturalKey", 300);
    const show = await currentShow(env.DB, naturalKey);
    if (!show) throw new RequestError("The show is no longer current", 409, "stale_show");
    const clientAt = new Date(requiredString(body?.clientAt, "clientAt", 50));
    if (!Number.isFinite(clientAt.getTime())) throw new RequestError("clientAt is invalid");
    let diagnostics = null;
    if (body?.diagnostics != null) {
      if (typeof body.diagnostics !== "object" || Array.isArray(body.diagnostics)) {
        throw new RequestError("diagnostics must be an object");
      }
      const encodedDiagnostics = JSON.stringify(body.diagnostics);
      if (encodedDiagnostics.length > 4000) throw new RequestError("diagnostics is too large");
      diagnostics = JSON.parse(encodedDiagnostics);
    }
    const event = {
      eventType,
      clientAt: clientAt.toISOString(),
      attemptId: body?.attemptId ? String(body.attemptId).slice(0, 100) : null,
      stage: body?.stage ? String(body.stage).slice(0, 100) : null,
      error: body?.error ? String(body.error).slice(0, 500) : null,
      diagnostics
    };
    return json(await recordCaptureEvent(env.DB, show, event), 200, origin);
  }

  throw new RequestError("Not found", 404, "not_found");
}

async function handleFetch(request, env, context) {
  const origin = allowedOrigin(request, env);
  if (origin === false) return json({ error: "origin_not_allowed" }, 403, null);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  try {
    return await route(request, env, origin, context);
  } catch (error) {
    if (error instanceof RequestError) {
      return json({ error: error.code, message: error.message }, error.status, origin);
    }
    console.error("Unhandled Worker error", error);
    return json({ error: "internal_server_error", message: "The tracker API could not complete the request" }, 500, origin);
  }
}

export default {
  fetch: handleFetch,
  async scheduled(_controller, env, context) {
    context.waitUntil((async () => {
      await finalizeExpiredShows(env.DB);
      await dispatchNotifications(env.DB, env);
    })().catch((error) => console.error("Finalization/notification cron failed", error)));
  }
};
