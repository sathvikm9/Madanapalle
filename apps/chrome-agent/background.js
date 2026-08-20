const VENUE = {
  venueCode: "SKMD",
  slug: "sri-krishna-a-c-4k-dolby-atmos-madanapalle"
};
const DISCOVERY_TODAY = "discovery:today";
const DISCOVERY_TOMORROW = "discovery:tomorrow";

chrome.runtime.onInstalled.addListener(async () => {
  await initializeAgent();
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => initializeAgent().catch((error) => recordFailure(error)));

async function initializeAgent() {
  await ensureBaseAlarms();
  const settings = await chrome.storage.sync.get({ enabled: false });
  if (!settings.enabled) return;
  const { knownShows = {} } = await chrome.storage.local.get({ knownShows: {} });
  await scheduleShows(Object.values(knownShows).flat());
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
  if (alarm.name === DISCOVERY_TODAY) return discover(indiaDateCode(0));
  if (alarm.name === DISCOVERY_TOMORROW) return discover(indiaDateCode(1));
  if (alarm.name.startsWith("preflight:")) {
    const show = await showForAlarm(alarm.name);
    if (show) await discover(show.dateCode);
    return;
  }
  if (alarm.name.startsWith("capture:")) {
    const show = await showForAlarm(alarm.name);
    if (show) await beginCapture(show);
    return;
  }
  if (alarm.name.startsWith("watchdog:")) {
    await handleCaptureWatchdog(alarm.name);
  }
}

async function handleMessage(message) {
  if (message.type === "RUN_DISCOVERY") {
    const result = await discover(indiaDateCode(0));
    return { ok: true, result };
  }
  if (message.type === "CAPTURE_RESULT") {
    const pending = (await chrome.storage.local.get("pendingCapture")).pendingCapture;
    if (!pending || pending.naturalKey !== message.result.naturalKey) throw new Error("Capture result did not match the pending show");
    const saved = await apiPost("/api/agent/capture", message.result);
    await chrome.storage.local.remove("pendingCapture");
    await chrome.alarms.clear(`watchdog:${encodeURIComponent(pending.naturalKey)}`);
    await recordSuccess(`Captured ${pending.showTimeLabel}: ${saved.sold} tickets`, { lastCapture: saved });
    await notify("Final capture uploaded", `${pending.showTimeLabel} · ${saved.sold} tickets · ₹${Math.round(saved.collectionPaise / 100).toLocaleString("en-IN")}`);
    return { ok: true };
  }
  if (message.type === "CAPTURE_ERROR") {
    const error = new Error(message.error || "The page capture failed");
    const pending = (await chrome.storage.local.get("pendingCapture")).pendingCapture;
    await chrome.storage.local.remove("pendingCapture");
    if (pending && Date.now() + 12_000 < new Date(pending.cutoffAt).getTime()) {
      await chrome.alarms.create(`capture:${encodeURIComponent(pending.naturalKey)}`, { when: Date.now() + 10_000 });
    }
    await recordFailure(error);
    return { ok: false, error: error.message };
  }
  return { ok: false, error: "Unknown message" };
}

async function discover(dateCode) {
  const pending = (await chrome.storage.local.get("pendingCapture")).pendingCapture;
  if (pending) return { skipped: "capture in progress" };
  const tab = await ensureAgentTab(dateCode, true);
  const payload = await sendToTab(tab.id, { type: "DISCOVER", dateCode });
  if (!payload?.ok) throw new Error(payload?.error || "BookMyShow discovery failed");
  const result = await apiPost("/api/agent/discovery", payload.data);
  await saveKnownShows(dateCode, payload.data.shows);
  await scheduleShows(payload.data.shows);
  await recordSuccess(`Discovered ${result.shows} shows for ${dateCode}`, { lastDiscovery: result });
  return result;
}

async function beginCapture(show) {
  const now = Date.now();
  const cutoff = new Date(show.cutoffAt).getTime();
  if (now >= cutoff) throw new Error(`${show.showTimeLabel} capture alarm ran after cutoff`);
  await chrome.storage.local.set({ pendingCapture: show });
  const tab = await ensureAgentTab(show.dateCode, false);
  const response = await sendToTab(tab.id, { type: "BEGIN_CAPTURE", show });
  if (!response?.ok) {
    await chrome.storage.local.remove("pendingCapture");
    throw new Error(response?.error || "Unable to open the seat page");
  }
  await chrome.alarms.create(`watchdog:${encodeURIComponent(show.naturalKey)}`, { when: Date.now() + 30_000 });
  await recordSuccess(`Opening ${show.showTimeLabel} final seat map`);
}

async function handleCaptureWatchdog(name) {
  const pending = (await chrome.storage.local.get("pendingCapture")).pendingCapture;
  if (!pending || name !== `watchdog:${encodeURIComponent(pending.naturalKey)}`) return;
  await chrome.storage.local.remove("pendingCapture");
  const error = new Error(`${pending.showTimeLabel} seat read did not finish in time`);
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
    await chrome.alarms.create(`capture:${encoded}`, { when: Math.max(Date.now() + 1000, captureAt + 15_000) });
  }
}

async function saveKnownShows(dateCode, shows) {
  const stored = await chrome.storage.local.get({ knownShows: {} });
  stored.knownShows[dateCode] = shows;
  await chrome.storage.local.set({ knownShows: stored.knownShows });
}

async function showForAlarm(name) {
  const naturalKey = decodeURIComponent(name.slice(name.indexOf(":") + 1));
  const { knownShows = {} } = await chrome.storage.local.get({ knownShows: {} });
  return Object.values(knownShows).flat().find((show) => show.naturalKey === naturalKey);
}

async function ensureAgentTab(dateCode, reload) {
  const url = `https://in.bookmyshow.com/cinemas/mdnp/${VENUE.slug}/buytickets/${VENUE.venueCode}/${dateCode}`;
  let { agentTabId } = await chrome.storage.local.get("agentTabId");
  let tab = agentTabId ? await chrome.tabs.get(agentTabId).catch(() => null) : null;
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: false, pinned: true });
    agentTabId = tab.id;
    await chrome.storage.local.set({ agentTabId });
  } else if (!tab.url?.includes(`/${VENUE.venueCode}/${dateCode}`)) {
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
      await new Promise((resolve) => setTimeout(resolve, 800));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("BookMyShow tab did not finish loading");
}

async function sendToTab(tabId, message) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      if (attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
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
  await notify("Sri Krishna capture needs attention", message);
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
