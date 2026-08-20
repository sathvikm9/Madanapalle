import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { getDashboard, validDate } from "./dashboard.js";
import { pool } from "./db.js";
import { ingestAgentCapture, ingestAgentDiscovery, requireCaptureAgent } from "./agent.js";

export function createApp({ scheduler } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes("*") || config.corsOrigins.includes(origin)) callback(null, true);
      else callback(new Error("Origin is not allowed"));
    }
  }));
  app.use(express.json({ limit: "64kb" }));

  app.get("/health", async (_request, response) => {
    try {
      await pool.query("SELECT 1");
      response.json({ ok: true, database: "connected", collector: scheduler?.status() || { running: false }, now: new Date().toISOString() });
    } catch (error) {
      response.status(503).json({ ok: false, database: "unavailable", error: error.message });
    }
  });

  app.get("/api/dashboard", async (request, response, next) => {
    try {
      const date = String(request.query.date || "");
      if (!validDate(date)) return response.status(400).json({ error: "date must be YYYY-MM-DD" });
      response.json(await getDashboard(date, String(request.query.venueCode || "SKMD")));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/shows/:id/captures", async (request, response, next) => {
    try {
      const result = await pool.query(
        `SELECT snap.*, COALESCE(json_agg(cat ORDER BY cat.id) FILTER (WHERE cat.id IS NOT NULL), '[]') AS categories
         FROM snapshots snap
         LEFT JOIN snapshot_categories cat ON cat.snapshot_id=snap.id
         WHERE snap.show_id=$1
         GROUP BY snap.id ORDER BY snap.captured_at ASC`,
        [request.params.id]
      );
      response.json({ showId: request.params.id, snapshots: result.rows });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agent/discovery", requireCaptureAgent, async (request, response) => {
    try {
      response.json(await ingestAgentDiscovery(request.body));
    } catch (error) {
      response.status(400).json({ error: "invalid_discovery", message: error.message });
    }
  });

  app.post("/api/agent/capture", requireCaptureAgent, async (request, response) => {
    try {
      response.json(await ingestAgentCapture(request.body));
    } catch (error) {
      response.status(400).json({ error: "invalid_capture", message: error.message });
    }
  });

  app.post("/api/admin/discover", async (request, response, next) => {
    try {
      if (!scheduler) return response.status(503).json({ error: "collector is disabled" });
      if (!config.adminToken || request.get("authorization") !== `Bearer ${config.adminToken}`) {
        return response.status(401).json({ error: "unauthorized" });
      }
      response.status(202).json({ accepted: true });
      scheduler.discoverAll().catch((error) => console.error("Manual discovery failed", error));
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _request, response, _next) => {
    console.error(error);
    response.status(500).json({ error: "internal_server_error", message: error.message });
  });
  return app;
}
