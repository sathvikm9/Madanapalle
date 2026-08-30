import {
  captureHistory,
  currentShow,
  dashboardData,
  finalizeExpiredShows,
  recordCaptureEvent,
  reconcileDiscovery,
  saveCapture
} from "./database.js";
import { analyticsCatalog, analyticsSummary } from "./analytics.js";
import {
  normalizeCapture,
  normalizeDiscovery,
  RequestError,
  requiredString,
  validDate
} from "./logic.js";
import { dashboardVenueForCode, publicVenues } from "./venues.js";

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
    "access-control-allow-methods": "GET, POST, OPTIONS",
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

async function route(request, env, origin) {
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

  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    const date = String(url.searchParams.get("date") || "");
    const venueCode = String(url.searchParams.get("venueCode") || "SKMD");
    if (!validDate(date)) throw new RequestError("date must be a real YYYY-MM-DD date");
    if (!dashboardVenueForCode(venueCode)) throw new RequestError(`Venue ${venueCode} is not configured`);
    return json(await dashboardData(env.DB, date, venueCode), 200, origin);
  }

  if (request.method === "GET" && url.pathname === "/api/analytics/catalog") {
    return json(await analyticsCatalog(env.DB), 200, origin);
  }

  if (request.method === "GET" && url.pathname === "/api/analytics/summary") {
    const movieTitle = requiredString(url.searchParams.get("movie"), "movie", 300);
    const venueCode = String(url.searchParams.get("venueCode") || "ALL");
    const startDate = String(url.searchParams.get("startDate") || "");
    const endDate = String(url.searchParams.get("endDate") || "");
    if (!dashboardVenueForCode(venueCode)) throw new RequestError(`Venue ${venueCode} is not configured`);
    if (!validDate(startDate) || !validDate(endDate)) {
      throw new RequestError("startDate and endDate must be real YYYY-MM-DD dates");
    }
    if (startDate > endDate) throw new RequestError("startDate must be on or before endDate");
    return json(await analyticsSummary(env.DB, { movieTitle, venueCode, startDate, endDate }), 200, origin);
  }

  const captureHistoryMatch = url.pathname.match(/^\/api\/shows\/(\d+)\/captures$/);
  if (request.method === "GET" && captureHistoryMatch) {
    return json(await captureHistory(env.DB, captureHistoryMatch[1]), 200, origin);
  }

  if (request.method === "POST" && url.pathname === "/api/agent/discovery") {
    requireAgent(request, env);
    const discovery = normalizeDiscovery(await bodyJson(request));
    return json(await reconcileDiscovery(env.DB, discovery), 200, origin);
  }

  if (request.method === "POST" && url.pathname === "/api/agent/capture") {
    requireAgent(request, env);
    const body = await bodyJson(request);
    const naturalKey = requiredString(body?.naturalKey, "naturalKey", 300);
    const show = await currentShow(env.DB, naturalKey);
    const capture = normalizeCapture(body, show, new Date());
    if (!capture.rawHash) {
      capture.rawHash = await sha256(JSON.stringify({
        naturalKey: capture.naturalKey,
        capturedAt: capture.capturedAt,
        categories: capture.categories
      }));
    }
    return json(await saveCapture(env.DB, show, capture), 200, origin);
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

async function handleFetch(request, env) {
  const origin = allowedOrigin(request, env);
  if (origin === false) return json({ error: "origin_not_allowed" }, 403, null);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  try {
    return await route(request, env, origin);
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
    context.waitUntil(finalizeExpiredShows(env.DB).catch((error) => console.error("Finalization cron failed", error)));
  }
};
