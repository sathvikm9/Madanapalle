import { BookMyShowBrowser } from "./bookmyshow.js";
import { config } from "./config.js";
import { migrate, pool } from "./db.js";
import { CollectorScheduler } from "./scheduler.js";

await migrate();
const browser = new BookMyShowBrowser();
const scheduler = new CollectorScheduler(browser);
const [command, argument] = process.argv.slice(2);

try {
  if (command === "discover") {
    console.log(JSON.stringify(await scheduler.discoverAll(), null, 2));
  } else if (command === "capture" && argument) {
    const result = await pool.query("SELECT * FROM shows WHERE id=$1", [argument]);
    if (!result.rows[0]) throw new Error(`Show ${argument} was not found`);
    const now = Date.now();
    if (now < new Date(result.rows[0].capture_at).getTime() || now >= new Date(result.rows[0].cutoff_at).getTime()) {
      throw new Error("Manual final capture is allowed only inside the configured final-minute window");
    }
    await scheduler.captureShow(result.rows[0]);
    console.log(`Captured show ${argument}`);
  } else {
    throw new Error("Usage: npm run discover OR npm run capture -- <show-id>");
  }
} finally {
  await browser.stop();
  await pool.end();
}
