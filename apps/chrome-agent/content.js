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
            listPricePaise: Math.round(Number(category.CurPrice || 0) * 100)
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
      error: error.message
    });
  }
}

async function captureSeats(show) {
  if (show.platform === "ticketnew") {
    const state = globalThis.SKCTTicketNew.readState(document);
    return globalThis.SKCTTicketNew.capture(state, show);
  }
  const selectSeats = await waitFor(() => Array.from(document.querySelectorAll("button")).find((button) => button.textContent.trim() === "Select Seats"), 20_000);
  selectSeats.click();
  const accessibility = await waitFor(() => document.querySelector('button[aria-label="Open accessibility seat selection"]'), 20_000);
  accessibility.click();
  const quantity = await waitFor(() => document.querySelector('select[aria-label="Select number of tickets, required"]'), 20_000);
  setSelect(quantity, singleTicketOption(quantity)?.value);
  const categorySelect = await waitFor(() => document.querySelector('select[aria-label="Select seat category"]'), 20_000);
  const rowSelect = await waitFor(() => document.querySelector('select[aria-label="Select row"]'), 20_000);
  const categoryOptions = Array.from(categorySelect.options).filter((option) => option.value).map((option) => ({ value: option.value, label: option.label }));
  const categories = [];

  for (const category of categoryOptions) {
    setSelect(categorySelect, category.value);
    await delay(80);
    const rows = Array.from(rowSelect.options).filter((option) => option.value).map((option) => option.value);
    let capacity = 0, available = 0, sold = 0, unknown = 0;
    for (const row of rows) {
      setSelect(rowSelect, row);
      const grid = await waitFor(() => document.querySelector('[aria-label^="Seats for Row"]'), 5_000);
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
    categories.push({
      name: category.label.replace(/\s*-\s*₹.*$/, "").trim(),
      price,
      capacity,
      available,
      sold,
      unknown
    });
  }

  const capturedAt = new Date().toISOString();
  return {
    naturalKey: show.naturalKey,
    attemptId: show.attemptId,
    capturedAt,
    captureMinute: indiaCaptureMinute(capturedAt),
    categories
  };
}

function singleTicketOption(select) {
  const options = Array.from(select.options).filter((option) => option.value && !option.disabled);
  return options.find((option) => {
    const text = `${option.label || ""} ${option.textContent || ""}`.trim();
    return option.value === "1" || Number(option.value) === 1 || /(^|\D)1(\D|$)/.test(text);
  }) || options[0];
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

async function waitFor(find, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = find();
    if (result) return result;
    await delay(100);
  }
  throw new Error("BookMyShow did not expose the expected booking control");
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function indiaCaptureMinute(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(new Date(value));
}
