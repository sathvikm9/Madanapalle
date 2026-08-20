import { createApp } from "./app.js";
import { BookMyShowBrowser } from "./bookmyshow.js";
import { config } from "./config.js";
import { finalizeExpiredShows, migrate, pool } from "./db.js";
import { CollectorScheduler } from "./scheduler.js";

await migrate();
const browser = new BookMyShowBrowser();
const scheduler = config.collectorEnabled ? new CollectorScheduler(browser) : null;
const app = createApp({ scheduler });
const server = app.listen(config.port, () => {
  console.log(`Madanapalle theatre tracker API listening on http://localhost:${config.port}`);
});
const maintenanceTimer = setInterval(() => {
  finalizeExpiredShows().catch((error) => console.error("Finalization maintenance failed", error));
}, 15_000);

if (scheduler) {
  scheduler.start().catch((error) => {
    console.error("Unable to start collector", error);
  });
}

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down`);
  server.close();
  clearInterval(maintenanceTimer);
  await scheduler?.stop();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
