chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

resumePendingCapture().catch(() => {});

async function handleMessage(message) {
  if (message.type === "DISCOVER") {
    if (message.platform === "ticketnew") {
      const state = globalThis.SKCTTicketNew.readState(document);
      return {
        ok: true,
        data: globalThis.SKCTTicketNew.discover(state, {
          venueCode: message.venueCode,
          cinemaId: message.cinemaId,
          captureStartAfterShowMinutes: message.captureStartAfterShowMinutes
        }, message.dateCode, location.href)
      };
    }
    return {
      ok: true,
      data: discoverShows(message.dateCode, message.venueCode, message.captureStartAfterShowMinutes)
    };
  }
  throw new Error("Unknown page-agent request");
}

function discoverShows(dateCode, venueCode, captureStartAfterShowMinutes = 10) {
  if (!/^[A-Z0-9]{2,20}$/.test(String(venueCode || ""))) throw new Error("The venue code was invalid");
  const script = Array.from(document.scripts).find((item) => item.textContent?.includes("window.__INITIAL_STATE__"));
  if (!script) throw new Error("BookMyShow data is unavailable. Check the pinned tab for a Cloudflare verification page.");
  const state = extractAssignedJson(script.textContent);
  const query = state?.venueShowtimesFunctionalApi?.queries?.[`getShowtimesByVenue-${venueCode}-${dateCode}`];
  const details = query?.data?.showDetailsTransformed;
  if (!details) throw new Error(`No ${venueCode} showtime payload was found for ${dateCode}`);
  const shows = [];
  const discoveredAt = new Date().toISOString();

  for (const event of details.Event || []) {
    for (const child of event.ChildEvents || []) {
      for (const show of child.ShowTimes || []) {
        const eventCode = String(child.EventCode || "");
        const sessionId = String(show.SessionId || "");
        const naturalKey = [venueCode, dateCode, show.ShowTimeCode, sessionId, eventCode].join(":");
        const startAt = codeToDate(show.ShowDateTime).toISOString();
        const cutoffAt = codeToDate(show.CutOffDateTime).toISOString();
        shows.push({
          naturalKey,
          slotKey: [venueCode, dateCode, show.ShowTimeCode].join(":"),
          venueCode,
          platform: "bookmyshow",
          discoveredAt,
          dateCode,
          eventCode,
          sessionId,
          showDateTime: show.ShowDateTime,
          cutoffDateTime: show.CutOffDateTime,
          showTimeCode: show.ShowTimeCode,
          showTimeLabel: show.ShowTime,
          movieTitle: event.EventTitle || child.EventName,
          movieVariant: child.EventName || event.EventTitle,
          language: child.EventLanguage || "",
          format: child.EventDimension || "",
          attributes: show.Attributes || "",
          screenName: show.ScreenName || "",
          startAt,
          cutoffAt,
          captureAt: new Date(new Date(startAt).getTime() + Number(captureStartAfterShowMinutes) * 60_000).toISOString(),
          finalCaptureAt: new Date(new Date(cutoffAt).getTime() - 60_000).toISOString(),
          seatLayoutUrl: `https://in.bookmyshow.com/movies/mdnp/seat-layout/${eventCode}/${venueCode}/${sessionId}/${dateCode}`,
          categories: (show.Categories || []).map((category) => ({
            name: category.PriceDesc || "Category",
            priceCode: category.PriceCode || "",
            listPricePaise: Math.round(Number(category.CurPrice || 0) * 100),
            availabilityStatus: String(category.AvailStatus ?? "")
          }))
        });
      }
    }
  }
  return { venueCode, dateCode, shows };
}

async function resumePendingCapture() {
  const { pendingCaptures = {} } = await chrome.storage.local.get({ pendingCaptures: {} });
  let pending;
  if (location.hostname === "ticketnew.com" || location.hostname.endsWith(".ticketnew.com")) {
    const fromDate = new URLSearchParams(location.search).get("fromdate")?.replaceAll("-", "");
    pending = Object.values(pendingCaptures).find((show) => (
      show.platform === "ticketnew" && (!fromDate || show.dateCode === fromDate)
    ));
  } else {
    if (!location.pathname.includes("/seat-layout/")) return;
    const match = location.pathname.match(/\/seat-layout\/[^/]+\/([^/]+)\/([^/]+)\/(\d{8})/);
    if (!match) return;
    const [, venueCode, sessionId, dateCode] = match;
    pending = Object.values(pendingCaptures).find((show) => (
      show.venueCode === venueCode && show.sessionId === sessionId && show.dateCode === dateCode
    ));
  }
  if (!pending) return;
  try {
    const result = await captureSeats(pending);
    await chrome.runtime.sendMessage({ type: "CAPTURE_RESULT", result });
  } catch (error) {
    await chrome.runtime.sendMessage({
      type: "CAPTURE_ERROR",
      naturalKey: pending.naturalKey,
      attemptId: pending.attemptId,
      error: error.message,
      stage: error.captureStage || "read_seat_map",
      diagnostics: error.captureDiagnostics || capturePageDiagnostics("seat_capture")
    });
  }
}

async function captureSeats(show) {
  if (show.platform === "ticketnew") {
    const state = globalThis.SKCTTicketNew.readState(document);
    return globalThis.SKCTTicketNew.capture(state, show);
  }
  const selectSeats = await waitForControl(
    () => Array.from(document.querySelectorAll("button")).find((button) => button.textContent.trim() === "Select Seats"),
    "select_seats_button",
    20_000
  );
  selectSeats.click();
  const accessibility = await waitForControl(
    () => document.querySelector('button[aria-label="Open accessibility seat selection"]'),
    "accessibility_seat_button",
    20_000
  );
  accessibility.click();
  const quantity = await waitForControl(
    () => document.querySelector('select[aria-label="Select number of tickets, required"]'),
    "ticket_quantity_select",
    20_000
  );
  const ticketOption = globalThis.SKCTBookMyShow.singleTicketOption(quantity);
  const noTicketOptions = globalThis.SKCTBookMyShow.enabledTicketOptions(quantity).length === 0;
  if (ticketOption) setSelect(quantity, ticketOption.value);
  const categorySelect = await waitForControl(
    () => document.querySelector('select[aria-label="Select seat category"]'),
    "seat_category_select",
    20_000
  );
  const rowSelect = await waitForControl(
    () => document.querySelector('select[aria-label="Select row"]'),
    "seat_row_select",
    20_000
  );
  const categoryOptions = Array.from(categorySelect.options).filter((option) => option.value).map((option) => ({ value: option.value, label: option.label }));
  const observedCategories = [];

  for (const category of categoryOptions) {
    setSelect(categorySelect, category.value);
    await delay(80);
    const rows = Array.from(rowSelect.options).filter((option) => option.value).map((option) => option.value);
    let capacity = 0, available = 0, sold = 0, unknown = 0;
    for (const row of rows) {
      setSelect(rowSelect, row);
      const grid = await waitForControl(
        () => document.querySelector('[aria-label^="Seats for Row"]'),
        "seat_grid",
        5_000,
        { category: category.label, row }
      );
      await delay(25);
      for (const seat of grid.querySelectorAll("[aria-label]")) {
        const label = seat.getAttribute("aria-label") || "";
        const disabled = seat.getAttribute("aria-disabled") === "true";
        const pressed = seat.getAttribute("aria-pressed") === "true";
        capacity += 1;
        if (/^select seat/i.test(label) && !disabled && !pressed) available += 1;
        else if (disabled || /sold|unavailable|booked|taken/i.test(label)) sold += 1;
        else unknown += 1;
      }
    }
    const price = Number((category.label.match(/₹\s*([\d.]+)/) || [])[1] || 0);
    observedCategories.push({
      name: category.label.replace(/\s*-\s*₹.*$/, "").trim(),
      price,
      capacity,
      available,
      sold,
      unknown
    });
  }

  const capturedAt = new Date().toISOString();
  const categories = globalThis.SKCTBookMyShow.completeFromVerifiedLayout(
    show.venueCode,
    show.categories,
    observedCategories
  );
  const fullySold = globalThis.SKCTBookMyShow.isFullySold(categories);
  if (noTicketOptions && !fullySold) {
    throw new Error("BookMyShow removed ticket quantities, but the exposed seat map was not completely sold out");
  }
  return {
    naturalKey: show.naturalKey,
    attemptId: show.attemptId,
    capturedAt,
    captureMinute: indiaCaptureMinute(capturedAt),
    categories,
    ...(noTicketOptions ? {
      housefullEvidence: {
        noTicketOptions: true,
        seatMapVerified: true,
        layoutSignature: globalThis.SKCTBookMyShow.layoutSignature(categories)
      }
    } : {})
  };
}

function extractAssignedJson(text) {
  const marker = text.indexOf("window.__INITIAL_STATE__");
  const start = text.indexOf("{", marker);
  let depth = 0, inString = false, escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return JSON.parse(text.slice(start, index + 1));
  }
  throw new Error("BookMyShow page data was incomplete");
}

function codeToDate(code) {
  return new Date(`${code.slice(0, 4)}-${code.slice(4, 6)}-${code.slice(6, 8)}T${code.slice(8, 10)}:${code.slice(10, 12)}:00+05:30`);
}

function setSelect(element, value) {
  if (!value) throw new Error(`No option was available for ${element.getAttribute("aria-label")}`);
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

async function waitForControl(find, control, timeout, context = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = find();
    if (result) return result;
    await delay(100);
  }
  const error = new Error(`BookMyShow did not expose ${control.replaceAll("_", " ")}`);
  error.captureStage = `wait_${control}`;
  error.captureDiagnostics = capturePageDiagnostics(control, context);
  throw error;
}

function capturePageDiagnostics(missingControl, context = {}) {
  const pageText = document.body?.innerText || "";
  const buttonLabels = Array.from(document.querySelectorAll("button"))
    .map((button) => (button.getAttribute("aria-label") || button.textContent || "").trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((label) => label.slice(0, 80));
  const selectLabels = Array.from(document.querySelectorAll("select"))
    .map((select) => select.getAttribute("aria-label") || "unlabelled")
    .slice(0, 12);
  const url = new URL(location.href);

  return {
    missingControl,
    pageKind: detectPageKind(pageText),
    pageUrl: `${url.origin}${url.pathname}`.slice(0, 500),
    pageTitle: document.title.slice(0, 160),
    readyState: document.readyState,
    initialStatePresent: Array.from(document.scripts).some((script) => script.textContent?.includes("window.__INITIAL_STATE__")),
    buttonLabels,
    selectLabels,
    bodyTextLength: pageText.length,
    context
  };
}

function detectPageKind(pageText) {
  if (
    /just a moment|attention required|verify you are human|checking your browser/i.test(document.title) ||
    document.querySelector('#challenge-running, .cf-challenge, iframe[src*="challenges.cloudflare.com"]')
  ) return "cloudflare_challenge";
  if (/booking(?:s)? (?:are )?closed|sales (?:are )?closed|show has (?:already )?started/i.test(pageText)) {
    return "booking_closed";
  }
  if (location.pathname.includes("/seat-layout/")) return "bookmyshow_seat_layout";
  if (location.hostname.includes("bookmyshow.com")) return "bookmyshow_other";
  return "unknown";
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function indiaCaptureMinute(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(new Date(value));
}
