import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const here = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(here, "../../..");
const venueFile = path.join(rootDir, "config", "venues.json");
const venueConfig = JSON.parse(fs.readFileSync(venueFile, "utf8"));

function integer(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: integer("PORT", 8787),
  databaseUrl: process.env.DATABASE_URL || "postgres://tracker:tracker@localhost:5432/tracker",
  collectorEnabled: process.env.COLLECTOR_ENABLED === "true",
  headless: process.env.HEADLESS === "true",
  browserDataDir: path.resolve(rootDir, process.env.BROWSER_DATA_DIR || "playwright-data"),
  discoveryIntervalMs: integer("DISCOVERY_INTERVAL_SECONDS", 120) * 1000,
  discoveryDaysAhead: integer("DISCOVERY_DAYS_AHEAD", 1),
  schedulerTickMs: integer("SCHEDULER_TICK_SECONDS", 5) * 1000,
  captureRetryMs: integer("CAPTURE_RETRY_SECONDS", 20) * 1000,
  corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:5173")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  adminToken: process.env.ADMIN_TOKEN || "",
  captureAgentToken: process.env.CAPTURE_AGENT_TOKEN || "",
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || "",
  timezone: venueConfig.timezone,
  city: venueConfig.city,
  venues: venueConfig.venues.filter((venue) => venue.active)
};
