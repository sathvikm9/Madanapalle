import crypto from "node:crypto";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { calculateCollection, parseVenueShowsFromHtml } from "@skct/core";
import { config } from "./config.js";

export class BookMyShowBrowser {
  context = null;
  operation = Promise.resolve();

  async start() {
    if (this.context) return;
    await fs.mkdir(config.browserDataDir, { recursive: true });
    this.context = await chromium.launchPersistentContext(config.browserDataDir, {
      headless: config.headless,
      viewport: { width: 1440, height: 1000 },
      locale: "en-IN",
      timezoneId: config.timezone
    });
  }

  async stop() {
    await this.context?.close();
    this.context = null;
  }

  async exclusive(task) {
    const previous = this.operation;
    let release;
    this.operation = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      await this.start();
      return await task();
    } finally {
      release();
    }
  }

  venueUrl(venue, dateCode) {
    return `https://in.bookmyshow.com/cinemas/${config.city.slug}/${venue.slug}/buytickets/${venue.venueCode}/${dateCode}`;
  }

  async discover(venue, dateCode) {
    return this.exclusive(async () => {
      const page = await this.context.newPage();
      try {
        const response = await page.goto(this.venueUrl(venue, dateCode), {
          waitUntil: "domcontentloaded",
          timeout: 60_000
        });
        if (!response?.ok()) throw new Error(`BookMyShow returned HTTP ${response?.status() || "unknown"}`);
        await page.waitForFunction(
          () => Array.from(document.scripts).some((script) => script.textContent?.includes("window.__INITIAL_STATE__")),
          null,
          { timeout: 30_000 }
        );
        const html = await page.content();
        return parseVenueShowsFromHtml(html, venue, dateCode);
      } finally {
        await page.close();
      }
    });
  }

  async capture(show) {
    return this.exclusive(async () => {
      const page = await this.context.newPage();
      try {
        const venue = config.venues.find((item) => item.venueCode === (show.venue_code || show.venueCode));
        if (!venue) throw new Error(`Unknown venue ${show.venue_code || show.venueCode}`);
        const response = await page.goto(this.venueUrl(venue, show.show_date_code || show.showDateCode), {
          waitUntil: "domcontentloaded",
          timeout: 60_000
        });
        if (!response?.ok()) throw new Error(`Venue page returned HTTP ${response?.status() || "unknown"}`);

        await this.openCurrentSeatSession(page, show);

        await this.openSeatLayout(page);
        const categories = await this.readAllSeats(page, show);
        const calculated = calculateCollection(categories);
        if (!calculated.capacity) throw new Error("BookMyShow returned a zero-seat layout");
        if (calculated.unknown) {
          throw new Error(`BookMyShow exposed ${calculated.unknown} seats with an unknown state`);
        }
        const capturedAt = new Date().toISOString();
        const captureMinute = new Intl.DateTimeFormat("en-CA", {
          timeZone: config.timezone,
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", hour12: false
        }).format(new Date(capturedAt));
        const rawHash = crypto
          .createHash("sha256")
          .update(JSON.stringify({ showId: show.id, capturedAt, categories: calculated.categories }))
          .digest("hex");

        return {
          ...calculated,
          capturedAt,
          captureMinute,
          source: "bookmyshow-accessibility-seat-map",
          rawHash
        };
      } finally {
        await page.close();
      }
    });
  }

  async openCurrentSeatSession(page, show) {
    const eventCode = show.event_code || show.eventCode;
    const showTime = show.show_time_label || show.showTimeLabel;
    const sessionId = String(show.session_id || show.sessionId);
    const sessionPattern = new RegExp(`/SKMD/${sessionId}/`);
    const movieLink = page.locator(`a[href*="${eventCode}"]`).first();
    await movieLink.waitFor({ state: "visible", timeout: 30_000 });
    const row = page.getByRole("row").filter({ has: movieLink });
    const scopedButton = row.getByRole("button", { name: `Book ${showTime}`, exact: true });
    const button = await scopedButton.count()
      ? scopedButton
      : page.getByRole("button", { name: `Book ${showTime}`, exact: true });
    await button.waitFor({ state: "visible", timeout: 20_000 });
    await Promise.all([
      page.waitForURL(sessionPattern, { timeout: 30_000 }),
      button.click({ timeout: 20_000 })
    ]);
  }

  async openSeatLayout(page) {
    const selectSeats = page.getByRole("button", { name: /^Select Seats$/i });
    const quantityModalVisible = await selectSeats
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (quantityModalVisible) {
      await selectSeats.click({ timeout: 15_000 });
    }

    const accessibility = page.getByRole("button", { name: /Open accessibility seat selection/i });
    await accessibility.waitFor({ state: "visible", timeout: 30_000 });
    await accessibility.click({ timeout: 15_000 });

    const quantity = page.locator('select[aria-label="Select number of tickets, required"]');
    await quantity.waitFor({ state: "visible", timeout: 20_000 });
    await quantity.selectOption({ label: "1 Ticket" });
  }

  async readAllSeats(page, show) {
    const categorySelect = page.locator('select[aria-label="Select seat category"]');
    const rowSelect = page.locator('select[aria-label="Select row"]');
    const categoryOptions = await categorySelect.locator("option").evaluateAll((options) =>
      options.filter((option) => option.value).map((option) => ({ value: option.value, label: option.label }))
    );
    if (!categoryOptions.length) throw new Error("No seat categories were exposed by BookMyShow");

    const advertised = new Map(
      (show.advertised_categories || show.advertisedCategories || []).map((category) => [
        String(category.name || "").toLowerCase(),
        Number(category.listPricePaise || category.list_price_paise || 0)
      ])
    );
    const categories = [];

    for (const category of categoryOptions) {
      await categorySelect.selectOption(category.value);
      const rowOptions = await rowSelect.locator("option").evaluateAll((options) =>
        options.filter((option) => option.value).map((option) => ({ value: option.value, label: option.label }))
      );
      let capacity = 0;
      let available = 0;
      let sold = 0;
      let unknown = 0;

      for (const row of rowOptions) {
        await rowSelect.selectOption(row.value);
        const grid = page.locator('[aria-label^="Seats for Row"]');
        await grid.waitFor({ state: "visible", timeout: 10_000 });
        const seats = await grid.locator("[aria-label]").evaluateAll((elements) =>
          elements.map((element) => ({
            label: element.getAttribute("aria-label") || "",
            disabled: element.getAttribute("aria-disabled") === "true",
            pressed: element.getAttribute("aria-pressed") === "true"
          }))
        );

        for (const seat of seats) {
          capacity += 1;
          if (/^select seat/i.test(seat.label) && !seat.disabled && !seat.pressed) available += 1;
          else if (seat.disabled || /sold|unavailable|booked|taken/i.test(seat.label)) sold += 1;
          else unknown += 1;
        }
      }

      const priceMatch = category.label.match(/₹\s*([\d.]+)/);
      const categoryName = category.label.replace(/\s*-\s*₹.*$/, "").trim();
      const fallbackPricePaise = advertised.get(categoryName.toLowerCase()) || 0;
      categories.push({
        name: categoryName,
        price: priceMatch ? Number(priceMatch[1]) : fallbackPricePaise / 100,
        capacity,
        available,
        sold,
        unknown
      });
    }

    return categories;
  }
}
