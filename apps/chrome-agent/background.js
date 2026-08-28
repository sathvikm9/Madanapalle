import { canPauseVenueDiscovery, finalCaptureAt, nextCaptureWhen, preflightTimes } from "./schedule.js";
import { captureModeFor, recoveryChanges, refreshedRecoveryShow } from "./recovery.js";
import "./bookmyshow.js";

const VENUES = [
  {
    venueCode: "SKMD",
    shortName: "Sri Krishna",
    slug: "sri-krishna-a-c-4k-dolby-atmos-madanapalle",
    platform: "bookmyshow",
    captureStartAfterShowMinutes: 10
  },
  {
    venueCode: "SCM",
    shortName: "Sai Chitra",
    slug: "sai-chitra-theatre-a-c-4k-dolby-surround-7-1-madanapalle-c",
    platform: "ticketnew",
    cinemaId: 4903,
    captureStartAfterShowMinutes: 10
  },
  {
    venueCode: "RTDM",
    shortName: "Ravi",
    slug: "ravi-a-c-4k-laser-dolby-surround-71-madanapalle",
    platform: "bookmyshow",
    captureStartAfterShowMinutes: 15
  },
  {
    venueCode: "ASRM",
    shortName: "ASR",
    slug: "asr-a-c-4k-laser-dolby-surround-71-madanapalle",
    platform: "bookmyshow",
    captureStartAfterShowMinutes: 15
  }
];
const VENUE_BY_CODE = Object.fromEntries(VENUES.map((venue) => [venue.venueCode, venue]));
const DISCOVERY_TODAY = "discovery:today";
const LEGACY_DISCOVERY_TOMORROW = "discovery:tomorrow";
const INDIA_DAY_ROLLOVER = "discovery:india-day-rollover";
let pendingMutation = Promise.resolve();
let captureStateMutation = Promise.resolve();

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
  const today = indiaDateCode(0);
  await clearShowAlarmsOutsideDate(today);
  const todayShows = Object.entries(knownShows)
    .filter(([key]) => key.endsWith(`:${today}`))
    .flatMap(([, shows]) => shows);
  await scheduleShows(todayShows);
}

async function migrateSingleTheatreStorage() {
  const local = await chrome.storage.local.get({
    agentTabId: null,
    agentTabIds: {},
    pendingCapture: null,
    pendingCaptures: {},
    knownShows: {},
    captureStates: {},
    recoveryTabIds: {}
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
  await chrome.storage.local.set({
    agentTabIds,
    pendingCaptures,
    knownShows,
    captureStates: local.captureStates,
    recoveryTabIds: local.recoveryTabIds
  });
  await chrome.storage.local.remove(["agentTabId", "pendingCapture"]);
}

async function ensureBaseAlarms() {
  await chrome.alarms.clear(LEGACY_DISCOVERY_TOMORROW);
  await chrome.alarms.create(DISCOVERY_TODAY, { delayInMinutes: 0.1, periodInMinutes: 15 });
  await scheduleIndiaDayRollover();
}

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.alarms.onAlarm.addListener((alarm) => handleAlarm(alarm).catch((error) => recordFailure(error)));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleAlarm(alarm) {
  const settings = await chrome.storage.sync.get({ enabled: false });
  if (alarm.name === INDIA_DAY_ROLLOVER) {
    try {
      if (settings.enabled) {
        const today = indiaDateCode(0);
        await clearShowAlarmsOutsideDate(today);
        await closeAllRecoveryTabs();
        await discoverAll(today, { force: true });
      }
    } finally {
      await scheduleIndiaDayRollover();
    }
    return;
  }
  if (!settings.enabled) return;
  if (alarm.name === DISCOVERY_TODAY) return discoverAll(indiaDateCode(0));
  if (alarm.name.startsWith("preflight:") || alarm.name.startsWith("final-preflight:")) {
    const show = await showForAlarm(alarm.name);
    if (show) {
      let discoveryError = null;
      try {
        await discoverVenue(show.venueCode, show.dateCode, { allowImminent: true });
      } catch (error) {
        discoveryError = error;
      }
      const state = await getCaptureState(show.naturalKey);
      if (captureModeFor(show, state) === "recovery") {
        await prepareRecoverySeatLayout(show);
      }
      if (discoveryError) throw discoveryError;
    }
    return;
  }
  if (alarm.name.startsWith("capture:")) {
    const show = await showForAlarm(alarm.name);
    if (show) {
      try {
        await beginCapture(show);
      } catch (error) {
        await failCapture((await getPending(show.naturalKey)) || show, error, "open_seat_page");
      }
    }
    return;
  }
  if (alarm.name.startsWith("recovery-cleanup:")) {
    const show = await showForAlarm(alarm.name);
    if (show) {
      await updateCaptureState(show.naturalKey, { recoveryMode: false, recoveryEndedAt: new Date().toISOString() });
      await closeRecoveryTab(show.venueCode);
    }
    return;
  }
  if (alarm.name.startsWith("watchdog:")) await handleCaptureWatchdog(alarm.name);
}

async function handleMessage(message) {
  if (message.type === "RUN_DISCOVERY") {
    return { ok: true, result: await discoverAll(indiaDateCode(0), { force: true }) };
  }
  if (message.type === "CAPTURE_RESULT") {
    const pending = await getPending(message.result.naturalKey);
    if (!pending || pending.attemptId !== message.result.attemptId) {
      throw new Error("Capture result did not match the active attempt");
    }
    const result = { ...message.result };
    if (result.housefullEvidence) {
      const state = await getCaptureState(pending.naturalKey);
      const observedAt = new Date(result.capturedAt).getTime();
      const firstObservedAt = new Date(state.housefullCandidateAt || 0).getTime();
      const sameLayout = state.housefullCandidateSignature === result.housefullEvidence.layoutSignature;
      const differentDiscovery = !result.housefullEvidence.discoveryStatusVerified || (
        state.housefullCandidateObservationId &&
        result.housefullEvidence.discoveryObservedAt &&
        state.housefullCandidateObservationId !== result.housefullEvidence.discoveryObservedAt
      );
      const independentlyConfirmed = sameLayout && Number.isFinite(firstObservedAt) &&
        differentDiscovery && observedAt - firstObservedAt >= 15_000 && observedAt - firstObservedAt <= 5 * 60_000;
      if (!independentlyConfirmed) {
        await removePending(pending.naturalKey);
        await chrome.alarms.clear(`watchdog:${encodeURIComponent(pending.naturalKey)}`);
        await updateCaptureState(pending.naturalKey, {
          housefullCandidateAt: result.capturedAt,
          housefullCandidateSignature: result.housefullEvidence.layoutSignature,
          housefullCandidateObservationId: result.housefullEvidence.discoveryObservedAt || null,
          lastError: null
        });
        const venue = venueFor(pending.venueCode);
        if (result.housefullEvidence.discoveryStatusVerified) {
          try {
            await discoverVenue(pending.venueCode, pending.dateCode, { allowImminent: true });
          } catch {
            await scheduleShow(pending);
          }
        } else {
          await scheduleShow(pending);
        }
        await recordSuccess(`Housefull signal found for ${venue.shortName} ${pending.showTimeLabel}; confirming again`);
        return { ok: true, pendingHousefullConfirmation: true };
      }
      result.housefullEvidence = {
        ...result.housefullEvidence,
        confirmationCount: 2,
        firstObservedAt: state.housefullCandidateAt
      };
    }
    let saved;
    try {
      saved = await apiPost("/api/agent/capture", result);
    } catch (error) {
      await failCapture(pending, error, "upload_capture");
      return { ok: false, error: error.message };
    }
    await removePending(pending.naturalKey);
    await chrome.alarms.clear(`watchdog:${encodeURIComponent(pending.naturalKey)}`);
    const isFinalWindow = new Date(result.capturedAt).getTime() >= finalCaptureAt(pending);
    await updateCaptureState(pending.naturalKey, {
      lastSuccessAt: result.capturedAt,
      ...(pending.captureMode === "recovery" ? { lastRecoverySuccessAt: result.capturedAt } : {}),
      lastError: null,
      housefullCandidateAt: null,
      housefullCandidateSignature: null,
      housefullCandidateObservationId: null
    });
    await scheduleShow(pending);
    const venue = venueFor(pending.venueCode);
    const captureKind = result.housefullEvidence ? "Verified housefull" : (isFinalWindow ? "Final" : "Backup");
    await recordSuccess(
      `${captureKind} capture ${venue.shortName} ${pending.showTimeLabel}: ${saved.sold} tickets`,
      { lastCapture: saved }
    );
    await notify(
      `${captureKind} capture uploaded`,
      `${venue.shortName} · ${pending.showTimeLabel} · ${saved.sold} tickets · ₹${Math.round(saved.collectionPaise / 100).toLocaleString("en-IN")}`
    );
    return { ok: true };
  }
  if (message.type === "CAPTURE_ERROR") {
    const pending = message.naturalKey ? await getPending(message.naturalKey) : null;
    const error = new Error(message.error || "The page capture failed");
    error.captureDiagnostics = message.diagnostics || null;
    if (pending && (!message.attemptId || pending.attemptId === message.attemptId)) {
      await failCapture(pending, error, message.stage || "read_seat_map");
    } else {
      await recordFailure(error);
    }
    return { ok: false, error: error.message };
  }
  return { ok: false, error: "Unknown message" };
}

async function discoverAll(dateCode, { force = false } = {}) {
  const results = [];
  const failures = [];
  const local = await chrome.storage.local.get({ knownShows: {}, captureStates: {} });
  for (const venue of VENUES) {
    const knownVenueShows = local.knownShows[`${venue.venueCode}:${dateCode}`] || [];
    if (!force && canPauseVenueDiscovery(knownVenueShows, local.captureStates)) {
      results.push({ venueCode: venue.venueCode, venueName: venue.shortName, shows: 0, skipped: "last show captured" });
      continue;
    }
    try {
      results.push(await discoverVenue(venue.venueCode, dateCode));
    } catch (error) {
      failures.push(`${venue.shortName}: ${error.message}`);
    }
    if (venue !== VENUES.at(-1)) await delay(1_500);
  }
  if (failures.length) throw new Error(failures.join(" · "));
  const shows = results.reduce((total, result) => total + Number(result.shows || 0), 0);
  const allComplete = results.every((result) => result.skipped === "last show captured");
  await recordSuccess(allComplete
    ? `Daily captures complete for ${dateCode}; routine discovery paused until India date rollover`
    : `Discovered ${shows} shows across ${VENUES.length} theatres for ${dateCode}`,
  { lastDiscovery: { dateCode, shows, venues: results } });
  return { dateCode, shows, venues: results };
}

async function discoverVenue(venueCode, dateCode, { allowImminent = false } = {}) {
  const venue = venueFor(venueCode);
  if (await hasPendingForVenue(venueCode)) return { venueCode, shows: 0, skipped: "capture in progress" };
  if (!allowImminent && await hasImminentCapture(venueCode, dateCode)) {
    return { venueCode, shows: 0, skipped: "final capture is imminent" };
  }
  const data = await readVenuePage(venue, dateCode);
  const result = await apiPost("/api/agent/discovery", data);
  await saveKnownShows(venueCode, dateCode, data.shows);
  await scheduleShows(data.shows);
  return { venueCode, venueName: venue.shortName, ...result };
}

async function readVenuePage(venue, dateCode) {
  const tab = await ensureAgentTab(venue, dateCode, true);
  const payload = await sendToTab(tab.id, {
    type: "DISCOVER",
    dateCode,
    venueCode,
    platform: venue.platform,
    cinemaId: venue.cinemaId,
    captureStartAfterShowMinutes: venue.captureStartAfterShowMinutes
  });
  if (!payload?.ok) throw new Error(payload?.error || `${venue.shortName} discovery failed`);
  return payload.data;
}

async function beginCapture(show) {
  const venue = venueFor(show.venueCode);
  if (Date.now() >= new Date(show.cutoffAt).getTime()) {
    throw new Error(`${venue.shortName} ${show.showTimeLabel} capture alarm ran after cutoff`);
  }
  if (await getPending(show.naturalKey)) return;
  const state = await getCaptureState(show.naturalKey);
  const captureMode = captureModeFor(show, state);
  const attemptStartedAt = new Date().toISOString();
  const attemptId = `${Date.now()}-${crypto.randomUUID()}`;
  const pending = { ...show, attemptId, attemptStartedAt, captureMode };
  await updateCaptureState(show.naturalKey, { lastAttemptAt: attemptStartedAt });
  await addPending(pending);
  await postCaptureEvent(pending, "capture_started", { stage: `${captureMode}_capture` });
  const discoveryHousefull = discoveryHousefullResult(pending, venue);
  if (discoveryHousefull) {
    await handleMessage({ type: "CAPTURE_RESULT", result: discoveryHousefull });
    return;
  }
  await chrome.alarms.create(`watchdog:${encodeURIComponent(show.naturalKey)}`, { when: Date.now() + 50_000 });
  if (captureMode === "recovery") await openRecoverySeatLayout(pending);
  else await openSeatLayout(pending);
  await recordSuccess(`Opening ${venue.shortName} ${show.showTimeLabel} ${captureMode} seat map`);
}

function discoveryHousefullResult(show, venue) {
  if (venue.platform !== "bookmyshow" || !show.discoveredAt) return null;
  let categories;
  try {
    categories = globalThis.SKCTBookMyShow.completeFromVerifiedLayout(
      show.venueCode,
      show.categories,
      []
    );
  } catch {
    return null;
  }
  if (!globalThis.SKCTBookMyShow.isFullySold(categories)) return null;
  const capturedAt = new Date().toISOString();
  return {
    naturalKey: show.naturalKey,
    attemptId: show.attemptId,
    capturedAt,
    captureMinute: indiaCaptureMinute(capturedAt),
    categories,
    housefullEvidence: {
      noTicketOptions: false,
      seatMapVerified: false,
      discoveryStatusVerified: true,
      discoveryObservedAt: show.discoveredAt,
      layoutSignature: globalThis.SKCTBookMyShow.layoutSignature(categories)
    }
  };
}

async function handleCaptureWatchdog(name) {
  const naturalKey = decodeAlarmKey(name);
  const pending = await getPending(naturalKey);
  if (!pending) return;
  await removePending(naturalKey);
  const venue = venueFor(pending.venueCode);
  const error = new Error(`${venue.shortName} ${pending.showTimeLabel} seat read did not finish in time`);
  await failCapture(pending, error, "watchdog_timeout", { pendingAlreadyRemoved: true });
}

async function failCapture(show, error, stage, { pendingAlreadyRemoved = false } = {}) {
  if (!pendingAlreadyRemoved) await removePending(show.naturalKey);
  await chrome.alarms.clear(`watchdog:${encodeURIComponent(show.naturalKey)}`);
  const message = String(error?.message || error);
  const state = await getCaptureState(show.naturalKey);
  const recovery = recoveryChanges(show, state, {
    stage,
    error: message,
    diagnostics: error?.captureDiagnostics || null
  });
  const recoveryJustActivated = Boolean(recovery) && !state.recoveryMode;
  await updateCaptureState(show.naturalKey, { lastError: message, ...(recovery || {}) });
  await postCaptureEvent(show, "capture_failed", {
    stage,
    error: message,
    diagnostics: {
      ...(error?.captureDiagnostics || {}),
      captureMode: show.captureMode || "primary",
      recoveryActivated: Boolean(recovery)
    }
  });
  await scheduleShow(show);
  if (recovery) {
    let recoveryShow = show;
    try {
      if (recoveryJustActivated) recoveryShow = await refreshRecoveryShow(show, recovery, state);
      await prepareRecoverySeatLayout(recoveryShow);
    } catch (recoveryError) {
      await updateCaptureState(show.naturalKey, {
        lastRecoveryPreparationError: String(recoveryError?.message || recoveryError)
      });
    }
  }
  await recordFailure(error);
}

async function refreshRecoveryShow(show, recovery, previousState) {
  try {
    const venue = venueFor(show.venueCode);
    const data = await readVenuePage(venue, show.dateCode);
    const slotFound = data.shows.some((candidate) => candidate.slotKey === show.slotKey);
    if (!slotFound) {
      await updateCaptureState(show.naturalKey, {
        lastRecoveryDiscoveryError: `The refreshed ${venue.shortName} page did not expose ${show.showTimeLabel}; preserving the known session`
      });
      return show;
    }
    await apiPost("/api/agent/discovery", data);
    await saveKnownShows(show.venueCode, show.dateCode, data.shows);
    await scheduleShows(data.shows);
    const refreshed = refreshedRecoveryShow(show, data.shows);
    if (refreshed.naturalKey !== show.naturalKey) {
      await updateCaptureState(refreshed.naturalKey, {
        ...recovery,
        lastAttemptAt: previousState.lastAttemptAt || new Date().toISOString(),
        recoveryReason: `Session refreshed after ${recovery.recoveryReason}`.slice(0, 500)
      });
      await scheduleShow(refreshed);
    }
    return refreshed;
  } catch (error) {
    await updateCaptureState(show.naturalKey, {
      lastRecoveryDiscoveryError: String(error?.message || error)
    });
    return show;
  }
}

async function scheduleShows(shows) {
  for (const show of shows) await scheduleShow(show);
}

async function scheduleShow(show) {
  if (new Date(show.cutoffAt).getTime() <= Date.now()) return;
  const encoded = encodeURIComponent(show.naturalKey);
  const [backupPreflight, finalPreflight] = preflightTimes(show);
  if (backupPreflight > Date.now() + 5_000) {
    await chrome.alarms.create(`preflight:${encoded}`, { when: backupPreflight });
  }
  if (finalPreflight > Date.now() + 5_000) {
    await chrome.alarms.create(`final-preflight:${encoded}`, { when: finalPreflight });
  }
  const state = await getCaptureState(show.naturalKey);
  if (state.recoveryMode) {
    await chrome.alarms.create(`recovery-cleanup:${encoded}`, {
      when: new Date(show.cutoffAt).getTime() + 1_000
    });
  }
  const when = nextCaptureWhen(show, state);
  if (when != null) await chrome.alarms.create(`capture:${encoded}`, { when });
}

async function clearShowAlarmsOutsideDate(dateCode) {
  const alarms = await chrome.alarms.getAll();
  for (const alarm of alarms) {
    if (!/^(preflight|final-preflight|capture|watchdog|recovery-cleanup):/.test(alarm.name)) continue;
    const naturalKey = decodeAlarmKey(alarm.name);
    if (naturalKey.split(":")[1] !== dateCode) await chrome.alarms.clear(alarm.name);
  }
}

async function scheduleIndiaDayRollover() {
  const tomorrow = indiaDateCode(1);
  const midnight = new Date(
    `${tomorrow.slice(0, 4)}-${tomorrow.slice(4, 6)}-${tomorrow.slice(6, 8)}T00:00:02+05:30`
  ).getTime();
  await chrome.alarms.create(INDIA_DAY_ROLLOVER, { when: midnight });
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
  const url = discoveryUrl(venue, dateCode);
  const stored = await chrome.storage.local.get({ agentTabIds: {} });
  const agentTabIds = stored.agentTabIds;
  let tab = agentTabIds[venue.venueCode]
    ? await chrome.tabs.get(agentTabIds[venue.venueCode]).catch(() => null)
    : null;
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: false, pinned: true });
    agentTabIds[venue.venueCode] = tab.id;
    await chrome.storage.local.set({ agentTabIds });
  } else if (!tabMatchesDiscovery(tab.url, venue, dateCode)) {
    tab = await chrome.tabs.update(tab.id, { url, active: false });
  } else if (reload) {
    await chrome.tabs.reload(tab.id);
  }
  await waitForComplete(tab.id);
  return chrome.tabs.get(tab.id);
}

async function openSeatLayout(show) {
  const venue = venueFor(show.venueCode);
  const stored = await chrome.storage.local.get({ agentTabIds: {} });
  const agentTabIds = stored.agentTabIds;
  let tab = agentTabIds[show.venueCode]
    ? await chrome.tabs.get(agentTabIds[show.venueCode]).catch(() => null)
    : null;
  if (!tab) {
    tab = await chrome.tabs.create({ url: show.seatLayoutUrl, active: false, pinned: true });
    agentTabIds[show.venueCode] = tab.id;
    await chrome.storage.local.set({ agentTabIds });
  } else if (tab.url === show.seatLayoutUrl) {
    await chrome.tabs.reload(tab.id);
  } else {
    tab = await chrome.tabs.update(tab.id, { url: show.seatLayoutUrl, active: false });
  }
  await waitForComplete(tab.id);
}

async function prepareRecoverySeatLayout(show) {
  const stored = await chrome.storage.local.get({ recoveryTabIds: {} });
  const recoveryTabIds = { ...stored.recoveryTabIds };
  const existingId = recoveryTabIds[show.venueCode];
  if (existingId) await safeRemoveRecoveryTab(existingId, show.venueCode);
  const tab = await chrome.tabs.create({ url: show.seatLayoutUrl, active: true, pinned: true });
  recoveryTabIds[show.venueCode] = tab.id;
  await chrome.storage.local.set({ recoveryTabIds });
  return tab;
}

async function openRecoverySeatLayout(show) {
  const stored = await chrome.storage.local.get({ recoveryTabIds: {} });
  const recoveryTabIds = { ...stored.recoveryTabIds };
  let tab = recoveryTabIds[show.venueCode]
    ? await chrome.tabs.get(recoveryTabIds[show.venueCode]).catch(() => null)
    : null;
  if (tab && !tabMatchesRecovery(tab.url, show.venueCode)) tab = null;
  if (!tab) {
    tab = await chrome.tabs.create({ url: show.seatLayoutUrl, active: true, pinned: true });
    recoveryTabIds[show.venueCode] = tab.id;
    await chrome.storage.local.set({ recoveryTabIds });
  } else if (tab.url === show.seatLayoutUrl) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.tabs.reload(tab.id);
  } else {
    tab = await chrome.tabs.update(tab.id, { url: show.seatLayoutUrl, active: true });
  }
  await waitForComplete(tab.id);
}

async function closeRecoveryTab(venueCode) {
  const stored = await chrome.storage.local.get({ recoveryTabIds: {} });
  const recoveryTabIds = { ...stored.recoveryTabIds };
  const tabId = recoveryTabIds[venueCode];
  if (tabId) await safeRemoveRecoveryTab(tabId, venueCode);
  delete recoveryTabIds[venueCode];
  await chrome.storage.local.set({ recoveryTabIds });
}

async function closeAllRecoveryTabs() {
  const stored = await chrome.storage.local.get({ recoveryTabIds: {} });
  await Promise.all(Object.entries(stored.recoveryTabIds)
    .map(([venueCode, tabId]) => safeRemoveRecoveryTab(tabId, venueCode)));
  await chrome.storage.local.set({ recoveryTabIds: {} });
}

async function safeRemoveRecoveryTab(tabId, venueCode) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && tabMatchesRecovery(tab.url, venueCode)) await chrome.tabs.remove(tabId).catch(() => {});
}

function tabMatchesRecovery(tabUrl, venueCode) {
  try {
    const url = new URL(tabUrl);
    return url.hostname === "in.bookmyshow.com" &&
      url.pathname.includes("/seat-layout/") &&
      url.pathname.includes(`/${venueCode}/`);
  } catch {
    return false;
  }
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
  throw new Error("The booking tab did not finish loading");
}

function discoveryUrl(venue, dateCode) {
  if (venue.platform === "ticketnew") {
    const date = `${dateCode.slice(0, 4)}-${dateCode.slice(4, 6)}-${dateCode.slice(6, 8)}`;
    return `https://ticketnew.com/movies/madanapalle/${venue.slug}/${venue.cinemaId}?fromdate=${date}`;
  }
  return `https://in.bookmyshow.com/cinemas/mdnp/${venue.slug}/buytickets/${venue.venueCode}/${dateCode}`;
}

function tabMatchesDiscovery(tabUrl, venue, dateCode) {
  try {
    const url = new URL(tabUrl);
    if (venue.platform === "ticketnew") {
      return url.hostname.endsWith("ticketnew.com") &&
        url.pathname.endsWith(`/${venue.cinemaId}`) &&
        url.searchParams.get("fromdate")?.replaceAll("-", "") === dateCode;
    }
    return url.hostname === "in.bookmyshow.com" && url.pathname.includes(`/${venue.venueCode}/${dateCode}`);
  } catch {
    return false;
  }
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

async function getCaptureState(naturalKey) {
  await captureStateMutation;
  const { captureStates = {} } = await chrome.storage.local.get({ captureStates: {} });
  return captureStates[naturalKey] || {};
}

async function updateCaptureState(naturalKey, changes) {
  const operation = captureStateMutation.then(async () => {
    const { captureStates = {} } = await chrome.storage.local.get({ captureStates: {} });
    captureStates[naturalKey] = { ...(captureStates[naturalKey] || {}), ...changes };
    await chrome.storage.local.set({ captureStates });
    return captureStates[naturalKey];
  });
  captureStateMutation = operation.catch(() => {});
  return operation;
}

async function postCaptureEvent(show, eventType, extra = {}) {
  try {
    await apiPost("/api/agent/event", {
      eventType,
      naturalKey: show.naturalKey,
      attemptId: show.attemptId || null,
      clientAt: new Date().toISOString(),
      ...extra
    });
  } catch {
    // Telemetry must never prevent a seat capture or its retry.
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

function indiaCaptureMinute(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(new Date(value));
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
