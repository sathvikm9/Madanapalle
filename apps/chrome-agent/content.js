const COLLECTOR_KEEPALIVE_PORT = "collector-tab-keepalive";
const COLLECTOR_KEEPALIVE_INTERVAL_MS = 20 * 1000;
let collectorKeepalivePort = null;

void syncCollectorKeepalive();
setInterval(() => void syncCollectorKeepalive(), COLLECTOR_KEEPALIVE_INTERVAL_MS);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.enabled) void syncCollectorKeepalive();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

resumePendingCapture().catch(() => {});

async function syncCollectorKeepalive() {
  try {
    const { enabled = false } = await chrome.storage.local.get({ enabled: false });
    if (!enabled) {
      collectorKeepalivePort?.disconnect();
      collectorKeepalivePort = null;
      return;
    }
    if (!collectorKeepalivePort) {
      collectorKeepalivePort = chrome.runtime.connect({ name: COLLECTOR_KEEPALIVE_PORT });
      collectorKeepalivePort.onDisconnect.addListener(() => {
        collectorKeepalivePort = null;
      });
    }
    collectorKeepalivePort.postMessage({ type: "COLLECTOR_KEEPALIVE", at: new Date().toISOString() });
  } catch {
    collectorKeepalivePort = null;
  }
}

async function handleMessage(message) {
  if (message.type === "READ_BMS_MOVIE_METADATA") {
    if (location.hostname !== "in.bookmyshow.com") throw new Error("Movie metadata opened on an unexpected host");
    return { ok: true, result: globalThis.SKCTMovieMetadata.readPage(document, location) };
  }
  if (message.type === "READ_DISTRICT_MOVIE_METADATA") {
    if (!(location.hostname === "district.in" || location.hostname === "www.district.in" || location.hostname.endsWith(".district.in"))) {
      throw new Error("District movie metadata opened on an unexpected host");
    }
    return {
      ok: true,
      result: globalThis.SKCTMovieMetadata.readDistrictPage(document, location, message.request)
    };
  }
  if (message.type === "CAPTURE_TICKETNEW_SUMMARY") {
    if (!(location.hostname === "ticketnew.com" || location.hostname.endsWith(".ticketnew.com"))) {
      throw new Error("TicketNew summary capture opened on an unexpected host");
    }
    const state = globalThis.SKCTTicketNew.readState(document);
    return {
      ok: true,
      result: globalThis.SKCTTicketNew.capture(state, message.show)
    };
  }
  if (message.type === "CAPTURE_DIAGNOSTICS") {
    return { ok: true, diagnostics: capturePageDiagnostics("background_watchdog") };
  }
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
  if (new URLSearchParams(location.search).get("skctsummary") === "1") return;
  const { pendingCaptures = {} } = await chrome.storage.local.get({ pendingCaptures: {} });
  let pending;
  if (isTicketingHost(location.hostname)) {
    const fromDate = new URLSearchParams(location.search).get("fromdate")?.replaceAll("-", "");
    const pathSession = decodeURIComponent(location.pathname.split("/").filter(Boolean).at(-1) || "");
    const encodedSession = new URLSearchParams(location.search).get("encsessionid") || "";
    const ticketNewPending = Object.values(pendingCaptures).filter((show) => (
      show.platform === "ticketnew" && (!fromDate || show.dateCode === fromDate)
    ));
    pending = location.pathname.includes("/movies/seat-layout/")
      ? ticketNewPending.find((show) => (
        globalThis.SKCTTicketNew.sessionIdentityMatches(
          pathSession.toLowerCase(),
          encodedSession.toLowerCase(),
          String(show.sessionId).toLowerCase()
        )
      ))
      : ticketNewPending[0];
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
    if (!result) return;
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
    return captureTicketNewSeats(show);
  }
  const recoveryMode = show.captureMode === "recovery";
  const configuredRecoveryDeadline = new Date(show.captureDeadlineAt || 0).getTime();
  const recoveryDeadline = recoveryMode
    ? (show.isFinalRecovery && Number.isFinite(configuredRecoveryDeadline)
        ? configuredRecoveryDeadline
        : Date.now() + 28_000)
    : null;
  const deadline = recoveryMode ? recoveryDeadline : Date.now() + 28_000;
  const { categorySelect, rowSelect, noTicketOptions } = await prepareBookMyShowSeatControls(
    deadline,
    recoveryMode
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
    captureMode: show.captureMode || "primary",
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

async function captureTicketNewSeats(show) {
  if (globalThis.SKCTTicketNew.isLiveSeatLayout(location, show)) {
    return waitForStableTicketNewSeatLayout(show);
  }

  const state = globalThis.SKCTTicketNew.readState(document);
  globalThis.SKCTTicketNew.capture(state, show);
  const route = await openTicketNewSeatLayout(show, 8_000);
  if (route?.kind === "url") {
    location.replace(route.url);
    return null;
  }
  if (route?.kind === "live") return waitForStableTicketNewSeatLayout(show);
  if (route?.kind === "mismatch") {
    const error = new Error(`TicketNew opened a different session instead of ${show.sessionId}`);
    error.captureStage = "verify_ticketnew_session_identity";
    error.captureDiagnostics = capturePageDiagnostics("ticketnew_session_identity", {
      ...ticketNewIdentity(show),
      rejectedUrl: route.url
    });
    throw error;
  }

  const error = new Error(
    `TicketNew did not expose the exact ${show.movieTitle} ${show.showTimeLabel} control for session ${show.sessionId}`
  );
  error.captureStage = "wait_ticketnew_session_control";
  error.captureDiagnostics = capturePageDiagnostics("ticketnew_session_control", ticketNewIdentity(show));
  throw error;
}

async function openTicketNewSeatLayout(show, timeout) {
  const started = Date.now();
  let clicked = false;
  let clickedAt = 0;
  while (Date.now() - started < timeout) {
    if (globalThis.SKCTTicketNew.isLiveSeatLayout(location, show)) return { kind: "live" };
    if (clicked && Date.now() - clickedAt >= 500 && location.pathname.includes("/movies/seat-layout/")) {
      return { kind: "mismatch", url: location.href };
    }
    const url = globalThis.SKCTTicketNew.findLiveSeatLayoutUrl(document, show, location.href);
    if (url) return { kind: "url", url };
    if (!clicked) {
      const control = globalThis.SKCTTicketNew.findSessionControl(document, show);
      if (control) {
        clicked = true;
        clickedAt = Date.now();
        control.click();
      }
    }
    await delay(100);
  }
  return null;
}

async function waitForStableTicketNewSeatLayout(show) {
  const started = Date.now();
  let previousSignature = null;
  while (Date.now() - started < 8_000) {
    try {
      const result = globalThis.SKCTTicketNew.captureLive(document, show);
      const signature = result.categories
        .map((category) => `${category.name}:${category.capacity}`)
        .sort()
        .join("|");
      if (signature === previousSignature) {
        await rememberTicketNewSeatLayout(show);
        return result;
      }
      previousSignature = signature;
    } catch {
      previousSignature = null;
    }
    await delay(250);
  }
  const error = new Error("TicketNew live seat layout did not become stable within eight seconds");
  error.captureStage = "wait_ticketnew_live_seat_map";
  error.captureDiagnostics = capturePageDiagnostics("ticketnew_live_seat_map", ticketNewIdentity(show));
  throw error;
}

async function rememberTicketNewSeatLayout(show) {
  if (!globalThis.SKCTTicketNew.isLiveSeatLayout(location, show)) return;
  try {
    const { ticketNewLiveUrls = {} } = await chrome.storage.local.get({ ticketNewLiveUrls: {} });
    await chrome.storage.local.set({
      ticketNewLiveUrls: {
        ...ticketNewLiveUrls,
        [show.naturalKey]: {
          url: location.href,
          dateCode: show.dateCode,
          sessionId: show.sessionId,
          provider: isDistrictHost(location.hostname) ? "district" : "ticketnew",
          observedAt: new Date().toISOString()
        }
      }
    });
  } catch {
    // A successful seat count must not be discarded only because this optional cache failed.
  }
}

function ticketNewIdentity(show) {
  return {
    venueCode: show.venueCode,
    dateCode: show.dateCode,
    sessionId: show.sessionId,
    movieTitle: show.movieTitle,
    showTimeLabel: show.showTimeLabel,
    matchingSessionControl: Boolean(globalThis.SKCTTicketNew.findSessionControl(document, show)),
    roleButtonCount: document.querySelectorAll?.('[role="button"]').length || 0
  };
}

async function prepareBookMyShowSeatControls(deadline, recoveryMode) {
  let lastAction = "wait_booking_entry_control";
  let lastClickedAt = 0;
  let quantityChosen = false;
  let noTicketOptions = false;

  while (Date.now() < deadline) {
    const pageKind = detectPageKind(document.body?.innerText || "");
    if (pageKind === "cloudflare_challenge" || pageKind === "booking_closed") {
      throwCaptureControlError(pageKind, { recoveryAction: lastAction });
    }

    const controls = currentBookMyShowControls();
    const selectedCount = globalThis.SKCTBookMyShow.selectedTicketCount(controls.selectedQuantity);
    if (selectedCount != null) quantityChosen = selectedCount === 1;
    lastAction = globalThis.SKCTBookMyShow.recoveryAction(controls);
    if (controls.categorySelect && controls.rowSelect) {
      return { categorySelect: controls.categorySelect, rowSelect: controls.rowSelect, noTicketOptions };
    }

    if (controls.quantity && !quantityChosen) {
      const ticketOptions = globalThis.SKCTBookMyShow.enabledTicketOptions(controls.quantity);
      noTicketOptions = ticketOptions.length === 0;
      const ticketOption = globalThis.SKCTBookMyShow.singleTicketOption(controls.quantity);
      if (ticketOption) {
        setSelect(controls.quantity, ticketOption.value);
        quantityChosen = true;
        await delay(150);
        continue;
      }
    }

    let clickable = null;
    if (controls.oneTicket && !quantityChosen) {
      clickable = controls.oneTicket;
    } else if (controls.selectSeats && quantityChosen) {
      clickable = controls.selectSeats;
    } else if (controls.oneTicket) {
      // Retry the quantity tap if React did not commit the first interaction.
      clickable = controls.oneTicket;
    } else if (controls.accessibility) {
      clickable = controls.accessibility;
    }
    if (clickable && Date.now() - lastClickedAt >= 1_000) {
      activateBookMyShowControl(clickable);
      lastClickedAt = Date.now();
    }
    await delay(100);
  }

  const controls = currentBookMyShowControls();
  throwCaptureControlError("ticket_quantity_select_seats_or_seat_controls", {
    recoveryMode,
    lastAction,
    quantityChosen,
    selectedTicketCount: globalThis.SKCTBookMyShow.selectedTicketCount(controls.selectedQuantity),
    quantityPresent: Boolean(controls.quantity),
    oneTicketPresent: Boolean(controls.oneTicket),
    selectSeatsPresent: Boolean(controls.selectSeats),
    categorySelectPresent: Boolean(controls.categorySelect),
    rowSelectPresent: Boolean(controls.rowSelect)
  });
}

function activateBookMyShowControl(control) {
  control.scrollIntoView?.({ block: "center", inline: "center" });
  control.focus?.({ preventScroll: true });
  control.click();
}

function currentBookMyShowControls() {
  const interactiveControls = Array.from(document.querySelectorAll(
    'button, [role="button"], input[type="button"], input[type="submit"], [tabindex]:not([tabindex="-1"])'
  ));
  const quantityPromptPresent = /how many seats\??/i.test(document.body?.innerText || "");
  return {
    selectSeats: globalThis.SKCTBookMyShow.findSelectSeatsControl(interactiveControls),
    oneTicket: quantityPromptPresent
      ? globalThis.SKCTBookMyShow.findOneTicketControl(interactiveControls)
      : null,
    accessibility: document.querySelector('button[aria-label="Open accessibility seat selection"]'),
    quantity: document.querySelector('select[aria-label="Select number of tickets, required"]'),
    selectedQuantity: interactiveControls.find((control) => (
      globalThis.SKCTBookMyShow.selectedTicketCount(control) != null
    )) || null,
    categorySelect: document.querySelector('select[aria-label="Select seat category"]'),
    rowSelect: document.querySelector('select[aria-label="Select row"]'),
    visualSeatMap: Boolean(document.querySelector('[aria-label^="Seats for Row"], [aria-label^="Select seat"]'))
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
  const valueSetter = Object.getOwnPropertyDescriptor(globalThis.HTMLSelectElement?.prototype || {}, "value")?.set;
  if (valueSetter) valueSetter.call(element, value);
  else element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

async function waitForControl(find, control, timeout, context = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = find();
    if (result) return result;
    await delay(100);
  }
  throwCaptureControlError(control, context);
}

function throwCaptureControlError(control, context = {}) {
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
    .slice(0, 8)
    .map((label) => label.slice(0, 60));
  const selectLabels = Array.from(document.querySelectorAll("select"))
    .map((select) => (select.getAttribute("aria-label") || "unlabelled").slice(0, 60))
    .slice(0, 8);
  const roleButtonLabels = Array.from(document.querySelectorAll('[role="button"]'))
    .map((control) => (control.getAttribute("aria-label") || control.textContent || "").trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((label) => label.slice(0, 80));
  const url = new URL(location.href);

  return {
    missingControl,
    pageKind: detectPageKind(pageText),
    pageUrl: url.href.slice(0, 500),
    pageTitle: document.title.slice(0, 160),
    readyState: document.readyState,
    initialStatePresent: Array.from(document.scripts).some((script) => script.textContent?.includes("window.__INITIAL_STATE__")),
    ticketNewStatePresent: Boolean(document.querySelector('script#__NEXT_DATA__[type="application/json"]')),
    buttonLabels,
    roleButtonLabels,
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
  if (isTicketingHost(location.hostname) && location.pathname.includes("/movies/seat-layout/")) {
    return isDistrictHost(location.hostname) ? "district_seat_layout" : "ticketnew_seat_layout";
  }
  if (location.hostname.endsWith("ticketnew.com")) return "ticketnew_venue";
  if (isDistrictHost(location.hostname)) return "district_venue";
  if (location.pathname.includes("/seat-layout/")) return "bookmyshow_seat_layout";
  if (location.hostname.includes("bookmyshow.com")) return "bookmyshow_other";
  return "unknown";
}

function isDistrictHost(hostname) {
  return hostname === "district.in" || hostname === "www.district.in" || hostname.endsWith(".district.in");
}

function isTicketingHost(hostname) {
  return hostname === "ticketnew.com" || hostname.endsWith(".ticketnew.com") || isDistrictHost(hostname);
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function indiaCaptureMinute(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(new Date(value));
}
