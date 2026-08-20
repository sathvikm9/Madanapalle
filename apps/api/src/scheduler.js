import { indiaDateCode } from "@skct/core";
import { config } from "./config.js";
import {
  captureWindowOpenOrSoon,
  dueShows,
  finalizeExpiredShows,
  finishRun,
  markCaptureFailed,
  reconcileDiscoveredShows,
  saveSnapshot,
  startRun
} from "./db.js";

export class CollectorScheduler {
  constructor(browser) {
    this.browser = browser;
    this.timer = null;
    this.running = false;
    this.lastDiscoveryAt = 0;
    this.lastSuccessAt = null;
    this.lastError = null;
  }

  async start() {
    await this.browser.start();
    await this.tick();
    this.timer = setInterval(() => this.tick(), config.schedulerTickMs);
  }

  async stop() {
    clearInterval(this.timer);
    await this.browser.stop();
  }

  status() {
    return {
      running: Boolean(this.timer),
      busy: this.running,
      lastDiscoveryAt: this.lastDiscoveryAt ? new Date(this.lastDiscoveryAt).toISOString() : null,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError
    };
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const due = await dueShows(now);
      for (const show of due) await this.captureShow(show);
      await finalizeExpiredShows(new Date());

      const captureImminent = await captureWindowOpenOrSoon(new Date(), 90);
      if (!captureImminent && Date.now() - this.lastDiscoveryAt >= config.discoveryIntervalMs) {
        await this.discoverAll();
        this.lastDiscoveryAt = Date.now();
      }
      this.lastSuccessAt = new Date().toISOString();
      this.lastError = null;
    } catch (error) {
      this.lastError = String(error?.stack || error);
      console.error("Collector tick failed", error);
      await this.alert("collector_tick_failed", error).catch(() => {});
    } finally {
      this.running = false;
    }
  }

  async discoverAll() {
    const results = [];
    for (const venue of config.venues) {
      for (let day = 0; day <= config.discoveryDaysAhead; day += 1) {
        results.push(await this.discoverVenueDate(venue, indiaDateCode(new Date(), day)));
      }
    }
    return results;
  }

  async discoverVenueDate(venue, dateCode) {
    const targetDate = `${dateCode.slice(0, 4)}-${dateCode.slice(4, 6)}-${dateCode.slice(6, 8)}`;
    const runId = await startRun({ type: "discovery", venueCode: venue.venueCode, targetDate });
    try {
      const shows = await this.browser.discover(venue, dateCode);
      const result = await reconcileDiscoveredShows(venue, dateCode, shows);
      const details = {
        shows: shows.length,
        added: result.changes.added.length,
        replaced: result.changes.replaced.length,
        removed: result.changes.removed.length
      };
      await finishRun(runId, "success", details);
      return details;
    } catch (error) {
      await finishRun(runId, "failed", {}, error);
      await this.alert("discovery_failed", error, { venueCode: venue.venueCode, targetDate });
      throw error;
    }
  }

  async captureShow(show) {
    const runId = await startRun({
      type: "capture",
      venueCode: show.venue_code,
      targetDate: show.show_date,
      showId: show.id,
      details: { sessionId: show.session_id, eventCode: show.event_code }
    });
    const retryAt = new Date(Date.now() + config.captureRetryMs);

    try {
      const snapshot = await this.browser.capture(show);
      await saveSnapshot(show, snapshot, retryAt);
      await finishRun(runId, "success", {
        sold: snapshot.sold,
        collectionPaise: snapshot.collectionPaise,
        capturedAt: snapshot.capturedAt
      });
    } catch (error) {
      await markCaptureFailed(show.id, error, retryAt);
      await finishRun(runId, "failed", {}, error);
      await this.alert("capture_failed", error, {
        showId: show.id,
        movie: show.movie_title,
        showTime: show.show_time_label,
        cutoffAt: show.cutoff_at
      });
    }
  }

  async alert(type, error, context = {}) {
    if (!config.alertWebhookUrl) return;
    await fetch(config.alertWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type,
        message: String(error?.message || error),
        context,
        occurredAt: new Date().toISOString()
      })
    });
  }
}
