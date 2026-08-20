const VENUES = [
  {
    venueCode: "SKMD",
    shortName: "Sri Krishna",
    slug: "sri-krishna-a-c-4k-dolby-atmos-madanapalle"
  },
  {
    venueCode: "RTDM",
    shortName: "Ravi",
    slug: "ravi-a-c-4k-laser-dolby-surround-71-madanapalle"
  }
];
const VENUE_BY_CODE = Object.fromEntries(VENUES.map((venue) => [venue.venueCode, venue]));
const DISCOVERY_TODAY = "discovery:today";
const DISCOVERY_TOMORROW = "discovery:tomorrow";
let pendingMutation = Promise.resolve();

chrome.runtime.onInstalled.addListener(async () => {
  await initializeAgent();
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => initializeAgent().catch((error) => recordFailure(error)));

async function initializeAgent() {
  await migrateSingleTheatreStorage();
  await ensureBaseAlarms();
  const settings = await chrome.storage.sync.get({ enabled: false });
  if (!settings.enabled) return;
  const { knownShows = {} } = await chrome.storage.local.get({ knownShows: {} });
  await scheduleShows(Object.values(knownShows).flat());
}

async function migrateSingleTheatreStorage() {
  const local = await chrome.storage.local.get({
    agentTabId: null,
    agentTabIds: {},
    pendingCapture: null,
    pendingCaptures: {},
    knownShows: {}
  });
  const agentTabIds = { ...local.agentTabIds };
  const pendingCaptures = { ...local.pendingCaptures };
  const knownShows = { ...local.knownShows };
  if (local.agentTabId && !agentTabIds.SKMD) agentTabIds.SKMD = local.agentTabId;
  if (local.pendingCapture?.naturalKey) {
    pendingCaptures[local.pendingCapture.naturalKey] = { venueCode: "SKMD", ...local.pendingCapture };
  }
  for (const [key, shows] of Object.entries(local.knownShows)) {
    if (/^\d{8}$/.test(key)) {
      knownShows[`SKMD:${key}`] = shows.map((show) => ({ venueCode: "SKMD", ...show }));
      delete knownShows[key];
    }
  }
  await chrome.storage.local.set({ agentTabIds, pendingCaptures, knownShows });
  await chrome.storage.local.remove(["agentTabId", "pendingCapture"]);
}

async function ensureBaseAlarms() {
  await chrome.alarms.create(DISCOVERY_TODAY, { delayInMinutes: 0.1, periodInMinutes: 5 });
  await chrome.alarms.create(DISCOVERY_TOMORROW, { delayInMinutes: 0.2, periodInMinutes: 60 });
}

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.alarms.onAlarm.addListener((alarm) => handleAlarm(alarm).catch((error) => recordFailure(error)));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleAlarm(alarm) {
  const settings = await chrome.storage.sync.get({ enabled: false });
  if (!settings.enabled) return;
  if (alarm.name === DISCOVERY_TODAY) return discoverAll(indiaDateCode(0));
  if (alarm.name === DISCOVERY_TOMORROW) return discoverAll(indiaDateCode(1));
  if (alarm.name.startsWith("preflight:")) {
    const show = await showForAlarm(alarm.name);
    if (show) await discoverVenue(show.venueCode, show.dateCode, { allowImminent: true });
    return;
  }
  if (alarm.name.startsWith("capture:")) {
    const show = await showForAlarm(alarm.name);
    if (show) await beginCapture(show);
    return;
  }
  if (alarm.name.startsWith("watchdog:")) await handleCaptureWatchdog(alarm.name);
}

async function handleMessage(message) {
  if (message.type === "RUN_DISCOVERY") {
    return { ok: true, result: await discoverAll(indiaDateCode(0)) };
  }
  if (message.type === "CAPTURE_RESULT") {
    const pending = await getPending(message.result.naturalKey);
    if (!pending) throw new Error("Capture result did not match a pending show");
    const saved = await apiPost("/api/agent/capture", message.result);
    await removePending(pending.naturalKey);
    await chrome.alarms.clear(`watchdog:${encodeURIComponent(pending.naturalKey)}`);
    const venue = venueFor(pending.venueCode);
    await recordSuccess(`Captured ${venue.shortName} ${pending.showTimeLabel}: ${saved.sold} tickets`, { lastCapture: saved });
    await notify(
      "Final capture uploaded",
      `${venue.shortName} · ${pending.showTimeLabel} · ${saved.sold} tickets · ₹${Math.round(saved.collectionPaise / 100).toLocaleString("en-IN")}`
    );
    return { ok: true };
  }
  if (message.type === "CAPTURE_ERROR") {
    const pending = message.naturalKey ? await getPending(message.naturalKey) : null;
    const error = new Error(message.error || "The page capture failed");
    if (pending) {
      await removePending(pending.naturalKey);
      if (Date.now() + 12_000 < new Date(pending.cutoffAt).getTime()) {
        await chrome.alarms.create(`capture:${encodeURIComponent(pending.naturalKey)}`, { when: Date.now() + 10_000 });
      }
    }
    await recordFailure(error);
    return { ok: false, error: error.message };
  }
  return { ok: false, error: "Unknown message" };
}

async function discoverAll(dateCode) {
  const results = [];
  const failures = [];
  for (const venue of VENUES) {
    try {
      results.push(await discoverVenue(venue.venueCode, dateCode));
    } catch (error) {
      failures.push(`${venue.shortName}: ${error.message}`);
    }
    if (venue !== VENUES.at(-1)) await delay(1_500);
  }
  if (failures.length) throw new Error(failures.join(" · "));
  const shows = results.reduce((total, result) => total + Number(result.shows || 0), 0);
  await recordSuccess(
    `Discovered ${shows} shows across ${VENUES.length} theatres for ${dateCode}`,
    { lastDiscovery: { dateCode, shows, venues: results } }
  );
  return { dateCode, shows, venues: results };
}

async function discoverVenue(venueCode, dateCode, { allowImminent = false } = {}) {
  const venue = venueFor(venueCode);
  if (await hasPendingForVenue(venueCode)) return { venueCode, shows: 0, skipped: "capture in progress" };
  if (!allowImminent && await hasImminentCapture(venueCode, dateCode)) {
    return { venueCode, shows: 0, skipped: "final capture is imminent" };
  }
  const tab = await ensureAgentTab(venue, dateCode, true);
  const payload = await sendToTab(tab.id, { type: "DISCOVER", dateCode, venueCode });
  if (!payload?.ok) throw new Error(payload?.error || `${venue.shortName} discovery failed`);
  const result = await apiPost("/api/agent/discovery", payload.data);
  await saveKnownShows(venueCode, dateCode, payload.data.shows);
  await scheduleShows(payload.data.shows);
  return { venueCode, venueName: venue.shortName, ...result };
}

async function beginCapture(show) {
  const venue = venueFor(show.venueCode);
  if (Date.now() >= new Date(show.cutoffAt).getTime()) {
    throw new Error(`${venue.shortName} ${show.showTimeLabel} capture alarm ran after cutoff`);
  }
  await addPending(show);
  const tab = await ensureAgentTab(venue, show.dateCode, false);
  const response = await sendToTab(tab.id, { type: "BEGIN_CAPTURE", show });
  if (!response?.ok) {
    await removePending(show.naturalKey);
    throw new Error(response?.error || `Unable to open ${venue.shortName} seat page`);
  }
  await chrome.alarms.create(`watchdog:${encodeURIComponent(show.naturalKey)}`, { when: Date.now() + 30_000 });
  await recordSuccess(`Opening ${venue.shortName} ${show.showTimeLabel} final seat map`);
}

async function handleCaptureWatchdog(name) {
  const naturalKey = decodeAlarmKey(name);
  const pending = await getPending(naturalKey);
  if (!pending) return;
  await removePending(naturalKey);
  const venue = venueFor(pending.venueCode);
  const error = new Error(`${venue.shortName} ${pending.showTimeLabel} seat read did not finish in time`);
  await recordFailure(error);
  if (Date.now() + 7_000 < new Date(pending.cutoffAt).getTime()) {
    await chrome.alarms.create(`capture:${encodeURIComponent(pending.naturalKey)}`, { when: Date.now() + 5_000 });
  }
}

async function scheduleShows(shows) {
  for (const show of shows) {
    const captureAt = new Date(show.captureAt).getTime();
    const cutoffAt = new Date(show.cutoffAt).getTime();
    if (cutoffAt <= Date.now()) continue;
    const encoded = encodeURIComponent(show.naturalKey);
    if (captureAt - 90_000 > Date.now() + 5_000) {
      await chrome.alarms.create(`preflight:${encoded}`, { when: captureAt - 90_000 });
    }
    await chrome.alarms.create(`capture:${encoded}`, { when: Math.max(Date.now() + 1_000, captureAt + 15_000) });
  }
}

async function saveKnownShows(venueCode, dateCode, shows) {
  const stored = await chrome.storage.local.get({ knownShows: {} });
  stored.knownShows[`${venueCode}:${dateCode}`] = shows;
  await chrome.storage.local.set({ knownShows: stored.knownShows });
}

async function hasImminentCapture(venueCode, dateCode) {
  const { knownShows = {} } = await chrome.storage.local.get({ knownShows: {} });
  const now = Date.now();
  return (knownShows[`${venueCode}:${dateCode}`] || []).some((show) => {
    const captureAt = new Date(show.captureAt).getTime();
    const cutoffAt = new Date(show.cutoffAt).getTime();
    return cutoffAt > now && captureAt - now < 120_000;
  });
}

async function showForAlarm(name) {
  const naturalKey = decodeAlarmKey(name);
  const { knownShows = {} } = await chrome.storage.local.get({ knownShows: {} });
  return Object.values(knownShows).flat().find((show) => show.naturalKey === naturalKey);
}

function decodeAlarmKey(name) {
  return decodeURIComponent(name.slice(name.indexOf(":") + 1));
}

async function ensureAgentTab(venue, dateCode, reload) {
  const url = `https://in.bookmyshow.com/cinemas/mdnp/${venue.slug}/buytickets/${venue.venueCode}/${dateCode}`;
  const stored = await chrome.storage.local.get({ agentTabIds: {} });
  const agentTabIds = stored.agentTabIds;
  let tab = agentTabIds[venue.venueCode]
    ? await chrome.tabs.get(agentTabIds[venue.venueCode]).catch(() => null)
    : null;
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: false, pinned: true });
    agentTabIds[venue.venueCode] = tab.id;
    await chrome.storage.local.set({ agentTabIds });
  } else if (!tab.url?.includes(`/${venue.venueCode}/${dateCode}`)) {
    tab = await chrome.tabs.update(tab.id, { url, active: false });
  } else if (reload) {
    await chrome.tabs.reload(tab.id);
  }
  await waitForComplete(tab.id);
  return chrome.tabs.get(tab.id);
}

async function waitForComplete(tabId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      await delay(800);
      return;
    }
    await delay(250);
  }
  throw new Error("BookMyShow tab did not finish loading");
}

async function sendToTab(tabId, message) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      if (attempt === 5) throw error;
      await delay(500);
    }
  }
}

async function addPending(show) {
  return mutatePending((pending) => ({ ...pending, [show.naturalKey]: show }));
}

async function removePending(naturalKey) {
  return mutatePending((pending) => {
    const next = { ...pending };
    delete next[naturalKey];
    return next;
  });
}

async function mutatePending(update) {
  const operation = pendingMutation.then(async () => {
    const { pendingCaptures = {} } = await chrome.storage.local.get({ pendingCaptures: {} });
    const next = update(pendingCaptures);
    await chrome.storage.local.set({ pendingCaptures: next });
    return next;
  });
  pendingMutation = operation.catch(() => {});
  return operation;
}

async function getPending(naturalKey) {
  await pendingMutation;
  const { pendingCaptures = {} } = await chrome.storage.local.get({ pendingCaptures: {} });
  return pendingCaptures[naturalKey] || null;
}

async function hasPendingForVenue(venueCode) {
  await pendingMutation;
  const { pendingCaptures = {} } = await chrome.storage.local.get({ pendingCaptures: {} });
  return Object.values(pendingCaptures).some((show) => show.venueCode === venueCode);
}

async function apiPost(path, body) {
  const settings = await chrome.storage.sync.get({ apiBase: "" });
  const secrets = await chrome.storage.local.get({ agentToken: "" });
  if (!settings.apiBase || !secrets.agentToken) throw new Error("Open the extension settings and configure the API first");
  const response = await fetch(`${settings.apiBase.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secrets.agentToken}` },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `API returned ${response.status}`);
  return data;
}

function venueFor(venueCode) {
  const venue = VENUE_BY_CODE[venueCode];
  if (!venue) throw new Error(`Venue ${venueCode} is not configured in the Chrome agent`);
  return venue;
}

function indiaDateCode(daysAhead) {
  const shifted = new Date(Date.now() + daysAhead * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(shifted);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
}

async function recordSuccess(message, extra = {}) {
  await chrome.storage.local.set({ status: { ok: true, message, at: new Date().toISOString() }, ...extra });
}

async function recordFailure(error) {
  const message = String(error?.message || error);
  await chrome.storage.local.set({ status: { ok: false, message, at: new Date().toISOString() } });
  await notify("Theatre capture needs attention", message);
}

async function notify(title, message) {
  await chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon.svg"),
    title,
    message: message.slice(0, 240),
    priority: 2
  });
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
