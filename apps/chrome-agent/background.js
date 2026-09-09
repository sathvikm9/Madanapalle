import { canPauseVenueDiscovery, nextCaptureWhen, preflightTimes } from "./schedule.js";
import {
  captureModeFor,
  recoveryChanges,
  refreshedRecoveryShow,
  successfulAttemptAlreadyHandled
} from "./recovery.js";
import {
  discoveryRetryDelay,
  discoveryTabError,
  isDiscoveryTabFailure,
  tabBelongsToVenue
} from "./tab-health.js";
import {
  CAPTURE_OUTBOX_ALARM,
  captureKind,
  createCaptureOutboxEntry,
  orderedCaptureOutbox
} from "./capture-outbox.js";
import {
  finalSummaryWhen,
  hasFinalLiveCapture,
  isTicketNewSummary,
  needsBackupSummary,
  TICKETNEW_SUMMARY_METHOD
} from "./ticketnew-summary.js";
import "./bookmyshow.js";
import "./ticketnew.js";

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
    districtSlug: "sai-chitra-theatre-a-c-4k-laser-dolby-surround-7-madanapalle-in-madanapalle-CD4903",
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
const DISCOVERY_RETRY_PREFIX = "discovery-retry:";
const FINAL_SUMMARY_PREFIX = "ticketnew-final-summary:";
let pendingMutation = Promise.resolve();
let captureStateMutation = Promise.resolve();
let agentDiagnosticMutation = Promise.resolve();
let captureOutboxMutation = Promise.resolve();
let captureOutboxFlushPromise = null;
const venueDiscoveryOperations = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  await initializeAgent();
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => initializeAgent().catch((error) => recordFailure(error)));

async function initializeAgent() {
  await migrateSingleTheatreStorage();
  await ensureBaseAlarms();
  await flushCaptureOutbox().catch(() => {});
  const settings = await chrome.storage.sync.get({ enabled: false });
  if (!settings.enabled) return;
  const { knownShows = {} } = await chrome.storage.local.get({ knownShows: {} });
  const today = indiaDateCode(0);
  await clearShowAlarmsOutsideDate(today);
  await clearDiscoveryRetryAlarmsOutsideDate(today);
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
    recoveryTabIds: {},
    ticketNewLiveUrls: {},
    captureOutbox: {}
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
    recoveryTabIds: local.recoveryTabIds,
    ticketNewLiveUrls: local.ticketNewLiveUrls,
    captureOutbox: local.captureOutbox
  });
  await chrome.storage.local.remove(["agentTabId", "pendingCapture"]);
}

async function ensureBaseAlarms() {
  await chrome.alarms.clear(LEGACY_DISCOVERY_TOMORROW);
  await chrome.alarms.create(DISCOVERY_TODAY, { delayInMinutes: 0.1, periodInMinutes: 15 });
  await chrome.alarms.create(CAPTURE_OUTBOX_ALARM, { delayInMinutes: 0.1, periodInMinutes: 1 });
  await scheduleIndiaDayRollover();
}

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.alarms.onAlarm.addListener((alarm) => handleAlarm(alarm).catch((error) => recordFailure(error)));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleAlarm(alarm) {
  if (alarm.name === CAPTURE_OUTBOX_ALARM) {
    await flushCaptureOutbox();
    return;
  }
  const settings = await chrome.storage.sync.get({ enabled: false });
  if (alarm.name === INDIA_DAY_ROLLOVER) {
    try {
      if (settings.enabled) {
        const today = indiaDateCode(0);
        await clearShowAlarmsOutsideDate(today);
        await clearDiscoveryRetryAlarmsOutsideDate(today);
        await closeAllRecoveryTabs();
        await resetAgentTabsForNewDay(today);
        await discoverAll(today, { force: true });
      }
    } finally {
      await scheduleIndiaDayRollover();
    }
    return;
  }
  if (!settings.enabled) return;
  if (alarm.name.startsWith(DISCOVERY_RETRY_PREFIX)) {
    const { venueCode, dateCode } = discoveryRetryDetails(alarm.name);
    if (!VENUE_BY_CODE[venueCode] || dateCode !== indiaDateCode(0)) {
      await chrome.alarms.clear(alarm.name);
      return;
    }
    try {
      const result = await discoverVenue(venueCode, dateCode);
      await recordSuccess(`${VENUE_BY_CODE[venueCode].shortName} discovery recovered: ${result.shows || 0} shows found`);
    } catch (error) {
      const retry = isDiscoveryTabFailure(error)
        ? await discoveryRetryState(venueCode, dateCode)
        : null;
      if (!retry) await clearVenueDiscoveryFailure(venueCode, dateCode);
      await chrome.storage.local.set({
        status: {
          ok: false,
          message: retry
            ? `${VENUE_BY_CODE[venueCode].shortName} discovery still unavailable; retry ${retry.failureCount} scheduled`
            : `${VENUE_BY_CODE[venueCode].shortName} discovery failed outside the tab; normal discovery will retry`,
          at: new Date().toISOString()
        }
      });
    }
    return;
  }
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
      if (show.venueCode === "SCM" && !discoveryError) {
        await primeSaiChitraDistrictRoute(show).catch((error) => appendAgentDiagnostic({
          type: "sai_chitra_district_route_prime_failed",
          venueCode: show.venueCode,
          dateCode: show.dateCode,
          naturalKey: show.naturalKey,
          showTimeLabel: show.showTimeLabel,
          error: String(error?.message || error).slice(0, 500)
        }));
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
        const state = await getCaptureState(show.naturalKey);
        if (successfulAttemptAlreadyHandled(error, state)) {
          await recordIgnoredLatePageError(show.naturalKey, error);
          return;
        }
        await failCapture((await getPending(show.naturalKey)) || show, error, "open_seat_page");
      }
    }
    return;
  }
  if (alarm.name.startsWith(FINAL_SUMMARY_PREFIX)) {
    const show = await showForAlarm(alarm.name);
    if (show?.venueCode === "SCM") await captureSaiChitraSummaryEstimate(show, "final");
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
    const outboxEntry = createCaptureOutboxEntry(pending, result);
    try {
      await protectCaptureLocally(outboxEntry, {
        lastLocalCaptureAt: result.capturedAt,
        lastLocalLiveCaptureAt: result.capturedAt,
        lastLocalCaptureId: outboxEntry.clientCaptureId,
        lastSuccessAttemptId: pending.attemptId,
        ...(pending.captureMode === "recovery" ? { lastRecoverySuccessAt: result.capturedAt } : {}),
        lastError: null,
        lastUploadError: null,
        outboxPending: true,
        housefullCandidateAt: null,
        housefullCandidateSignature: null,
        housefullCandidateObservationId: null
      });
    } catch (error) {
      await failCapture(pending, error, "store_capture_outbox");
      return { ok: false, error: error.message };
    }
    await removePending(pending.naturalKey);
    await chrome.alarms.clear(`watchdog:${encodeURIComponent(pending.naturalKey)}`);
    await scheduleShow(pending);
    const venue = venueFor(pending.venueCode);
    await recordSuccess(
      `${captureKind(pending, result)} capture safely stored locally for ${venue.shortName} ${pending.showTimeLabel}; uploading now`,
      { captureOutboxCount: await captureOutboxCount() }
    );
    await flushCaptureOutbox();
    const queued = await captureOutboxHas(outboxEntry.clientCaptureId);
    return { ok: true, storedLocally: true, uploaded: !queued };
  }
  if (message.type === "CAPTURE_ERROR") {
    const pending = message.naturalKey ? await getPending(message.naturalKey) : null;
    const error = new Error(message.error || "The page capture failed");
    error.captureAttemptId = message.attemptId || null;
    error.captureDiagnostics = message.diagnostics || null;
    if (pending && (!message.attemptId || pending.attemptId === message.attemptId)) {
      await failCapture(pending, error, message.stage || "read_seat_map");
    } else {
      const state = message.naturalKey ? await getCaptureState(message.naturalKey) : {};
      if (successfulAttemptAlreadyHandled(error, state)) {
        await recordIgnoredLatePageError(message.naturalKey, error);
        return { ok: true, ignoredLatePageError: true };
      }
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

async function discoverVenue(venueCode, dateCode, options = {}) {
  const previous = venueDiscoveryOperations.get(venueCode) || Promise.resolve();
  const operation = previous.catch(() => {}).then(() => discoverVenueUnlocked(venueCode, dateCode, options));
  venueDiscoveryOperations.set(venueCode, operation);
  try {
    const result = await operation;
    await clearVenueDiscoveryFailure(venueCode, dateCode);
    return result;
  } catch (error) {
    if (isDiscoveryTabFailure(error)) {
      await scheduleVenueDiscoveryRetry(venueCode, dateCode, error);
    }
    throw error;
  } finally {
    if (venueDiscoveryOperations.get(venueCode) === operation) venueDiscoveryOperations.delete(venueCode);
  }
}

async function discoverVenueUnlocked(venueCode, dateCode, { allowImminent = false } = {}) {
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
  try {
    return await readPrimaryVenuePage(venue, dateCode);
  } catch (primaryError) {
    if (venue.venueCode !== "SCM") throw primaryError;
    try {
      const data = await readDistrictVenuePage(venue, dateCode);
      await appendAgentDiagnostic({
        type: "sai_chitra_district_fallback_succeeded",
        venueCode: venue.venueCode,
        dateCode,
        primaryError: String(primaryError?.message || primaryError).slice(0, 500),
        shows: data.shows.length
      });
      return data;
    } catch (districtError) {
      await appendAgentDiagnostic({
        type: "sai_chitra_district_fallback_failed",
        venueCode: venue.venueCode,
        dateCode,
        primaryError: String(primaryError?.message || primaryError).slice(0, 500),
        districtError: String(districtError?.message || districtError).slice(0, 500)
      });
      primaryError.message = `${primaryError.message} · District fallback: ${districtError.message}`;
      throw primaryError;
    }
  }
}

async function readPrimaryVenuePage(venue, dateCode) {
  try {
    return await readVenuePageOnce(venue, dateCode, true);
  } catch (error) {
    if (!isDiscoveryTabFailure(error)) throw error;
    await appendAgentDiagnostic({
      type: "discovery_tab_repair_started",
      venueCode: venue.venueCode,
      dateCode,
      stage: error.discoveryStage,
      error: error.message,
      oldTabId: error.tabId || null
    });
    try {
      const replacement = await replaceAgentTab(venue, dateCode);
      const data = await readVenuePageOnce(venue, dateCode, false);
      await appendAgentDiagnostic({
        type: "discovery_tab_recovered",
        venueCode: venue.venueCode,
        dateCode,
        newTabId: replacement.id,
        shows: data.shows.length
      });
      return data;
    } catch (replacementError) {
      const tagged = isDiscoveryTabFailure(replacementError)
        ? replacementError
        : discoveryTabError(replacementError, "fresh_tab_retry");
      tagged.tabRepairAttempted = true;
      await appendAgentDiagnostic({
        type: "discovery_tab_repair_failed",
        venueCode: venue.venueCode,
        dateCode,
        stage: tagged.discoveryStage,
        error: tagged.message,
        newTabId: tagged.tabId || null
      });
      throw tagged;
    }
  }
}

async function readVenuePageOnce(venue, dateCode, reload) {
  let tab;
  try {
    tab = await ensureAgentTab(venue, dateCode, reload);
  } catch (error) {
    throw discoveryTabError(error, "wait_for_complete", {
      tabId: error?.tabId || null,
      tabStatus: error?.tabStatus || null,
      tabUrl: error?.tabUrl || null
    });
  }
  let payload;
  try {
    payload = await sendToTab(tab.id, {
      type: "DISCOVER",
      dateCode,
      venueCode: venue.venueCode,
      platform: venue.platform,
      cinemaId: venue.cinemaId,
      slug: venue.slug,
      captureStartAfterShowMinutes: venue.captureStartAfterShowMinutes
    });
  } catch (error) {
    throw discoveryTabError(error, "content_script_unreachable", { tabId: tab.id, tabUrl: tab.url || null });
  }
  if (!payload?.ok || !Array.isArray(payload?.data?.shows)) {
    throw discoveryTabError(
      new Error(payload?.error || `${venue.shortName} discovery returned an invalid page result`),
      "invalid_discovery_payload",
      { tabId: tab.id, tabUrl: tab.url || null }
    );
  }
  return payload.data;
}

async function readDistrictVenuePage(venue, dateCode) {
  const url = districtDiscoveryUrl(venue, dateCode);
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url, active: false, pinned: false });
    await waitForComplete(tab.id);
    const payload = await sendToTab(tab.id, {
      type: "DISCOVER",
      dateCode,
      venueCode: venue.venueCode,
      platform: venue.platform,
      cinemaId: venue.cinemaId,
      slug: venue.slug,
      captureStartAfterShowMinutes: venue.captureStartAfterShowMinutes
    });
    if (!payload?.ok || !Array.isArray(payload?.data?.shows)) {
      throw new Error(payload?.error || "District returned an invalid Sai Chitra schedule");
    }
    if (!payload.data.shows.length) throw new Error(`District found no Sai Chitra shows for ${dateCode}`);
    return payload.data;
  } finally {
    if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function primeSaiChitraDistrictRoute(show) {
  const venue = venueFor(show.venueCode);
  const data = await readDistrictVenuePage(venue, show.dateCode);
  const fallback = data.shows.find((candidate) => candidate.naturalKey === show.naturalKey);
  if (!fallback?.directSeatLayoutUrl) {
    const slotCandidate = data.shows.find((candidate) => candidate.slotKey === show.slotKey);
    const mismatch = slotCandidate
      ? `${slotCandidate.movieTitle} session ${slotCandidate.sessionId}`
      : "no matching show";
    throw new Error(`District did not confirm ${show.movieTitle} ${show.showTimeLabel}; found ${mismatch}`);
  }

  const stored = await chrome.storage.local.get({ knownShows: {} });
  const key = `${show.venueCode}:${show.dateCode}`;
  const shows = (stored.knownShows[key] || []).map((candidate) => (
    candidate.naturalKey === show.naturalKey
      ? {
          ...candidate,
          directSeatLayoutUrl: fallback.directSeatLayoutUrl,
          districtRouteVerifiedAt: new Date().toISOString()
        }
      : candidate
  ));
  stored.knownShows[key] = shows;
  await chrome.storage.local.set({ knownShows: stored.knownShows });
  await appendAgentDiagnostic({
    type: "sai_chitra_district_route_primed",
    venueCode: show.venueCode,
    dateCode: show.dateCode,
    naturalKey: show.naturalKey,
    showTimeLabel: show.showTimeLabel
  });
}

async function beginCapture(show) {
  const venue = venueFor(show.venueCode);
  if (Date.now() >= new Date(show.cutoffAt).getTime()) {
    throw new Error(`${venue.shortName} ${show.showTimeLabel} capture alarm ran after cutoff`);
  }
  if (await getPending(show.naturalKey)) return;
  const state = await getCaptureState(show.naturalKey);
  const captureMode = captureModeFor(show, state);
  const captureShow = captureMode === "primary" ? await withCachedTicketNewSeatLayout(show) : show;
  const attemptStartedAt = new Date().toISOString();
  const attemptId = `${Date.now()}-${crypto.randomUUID()}`;
  const pending = { ...captureShow, attemptId, attemptStartedAt, captureMode };
  await updateCaptureState(show.naturalKey, { lastAttemptAt: attemptStartedAt });
  await addPending(pending);
  await postCaptureEvent(pending, "capture_started", { stage: `${captureMode}_capture` });
  const discoveryHousefull = discoveryHousefullResult(pending, venue);
  if (discoveryHousefull) {
    await handleMessage({ type: "CAPTURE_RESULT", result: discoveryHousefull });
    return;
  }
  const cutoffRemainingMs = new Date(show.cutoffAt).getTime() - Date.now();
  const watchdogDelayMs = Math.max(1_000, Math.min(50_000, cutoffRemainingMs - 1_000));
  await chrome.alarms.create(`watchdog:${encodeURIComponent(show.naturalKey)}`, { when: Date.now() + watchdogDelayMs });
  try {
    if (captureMode === "recovery") await openRecoverySeatLayout(pending);
    else await openSeatLayout(pending);
  } catch (error) {
    const taggedError = new Error(String(error?.message || error), { cause: error });
    taggedError.captureAttemptId = attemptId;
    throw taggedError;
  }
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
  if (needsBackupSummary(show, state)) {
    await captureSaiChitraSummaryEstimate(show, "backup").catch(async (summaryError) => {
      await appendAgentDiagnostic({
        type: "sai_chitra_summary_estimate_failed",
        phase: "backup",
        naturalKey: show.naturalKey,
        showTimeLabel: show.showTimeLabel,
        error: String(summaryError?.message || summaryError).slice(0, 500)
      });
    });
  }
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

async function captureSaiChitraSummaryEstimate(show, phase) {
  if (show.venueCode !== "SCM" || show.platform !== "ticketnew") return { skipped: "not Sai Chitra" };
  let state = await getCaptureState(show.naturalKey);
  if (phase === "final" && hasFinalLiveCapture(show, state)) {
    await appendAgentDiagnostic({
      type: "sai_chitra_final_summary_skipped",
      naturalKey: show.naturalKey,
      showTimeLabel: show.showTimeLabel,
      reason: "final live capture already protected"
    });
    return { skipped: "final live capture already protected" };
  }

  const attemptedAt = new Date().toISOString();
  await updateCaptureState(show.naturalKey, phase === "final"
    ? { summaryFinalAttemptedAt: attemptedAt }
    : { summaryBackupAttemptedAt: attemptedAt });

  const attemptId = `ticketnew-summary-${phase}-${Date.now()}-${crypto.randomUUID()}`;
  const result = await readTicketNewSummaryCapture({ ...show, attemptId });
  state = await getCaptureState(show.naturalKey);
  if (phase === "final" && hasFinalLiveCapture(show, state)) {
    await appendAgentDiagnostic({
      type: "sai_chitra_final_summary_skipped",
      naturalKey: show.naturalKey,
      showTimeLabel: show.showTimeLabel,
      reason: "final live capture completed while summary was loading"
    });
    return { skipped: "final live capture completed while summary was loading" };
  }

  const estimatedResult = {
    ...result,
    naturalKey: show.naturalKey,
    attemptId,
    captureMethod: TICKETNEW_SUMMARY_METHOD,
    summaryPhase: phase
  };
  const estimateShow = { ...show, attemptId, captureMode: "summary" };
  const outboxEntry = createCaptureOutboxEntry(estimateShow, estimatedResult);
  await protectCaptureLocally(outboxEntry, {
    lastEstimateAt: estimatedResult.capturedAt,
    lastEstimateCaptureId: outboxEntry.clientCaptureId,
    lastEstimatePhase: phase,
    lastEstimateError: null,
    lastUploadError: null,
    outboxPending: true
  });
  await appendAgentDiagnostic({
    type: "sai_chitra_summary_estimate_stored",
    phase,
    naturalKey: show.naturalKey,
    showTimeLabel: show.showTimeLabel,
    capturedAt: estimatedResult.capturedAt,
    sold: estimatedResult.categories.reduce((total, category) => total + Number(category.sold || 0), 0)
  });
  await recordSuccess(`${phase === "final" ? "Final" : "Backup"} TicketNew summary estimate safely stored for Sai Chitra ${show.showTimeLabel}`);
  await flushCaptureOutbox();
  return { storedLocally: true };
}

async function readTicketNewSummaryCapture(show) {
  const venue = venueFor(show.venueCode);
  const url = new URL(discoveryUrl(venue, show.dateCode));
  url.searchParams.set("skctsummary", "1");
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: url.toString(), active: false, pinned: false });
    await waitForComplete(tab.id);
    const payload = await sendToTab(tab.id, {
      type: "CAPTURE_TICKETNEW_SUMMARY",
      show
    });
    if (!payload?.ok || !Array.isArray(payload?.result?.categories)) {
      throw new Error(payload?.error || "TicketNew returned an invalid summary capture");
    }
    return payload.result;
  } finally {
    if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function recordIgnoredLatePageError(naturalKey, error) {
  await updateCaptureState(naturalKey, {
    lastIgnoredLatePageErrorAt: new Date().toISOString(),
    lastIgnoredLatePageError: String(error?.message || error).slice(0, 500)
  });
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
  const state = await getCaptureState(show.naturalKey);
  const [backupPreflight, finalPreflight] = preflightTimes(show);
  if (backupPreflight > Date.now() + 5_000) {
    await chrome.alarms.create(`preflight:${encoded}`, { when: backupPreflight });
  }
  if (finalPreflight > Date.now() + 5_000) {
    await chrome.alarms.create(`final-preflight:${encoded}`, { when: finalPreflight });
  }
  const finalSummary = finalSummaryWhen(show);
  if (show.venueCode === "SCM" && !state.summaryFinalAttemptedAt && finalSummary != null) {
    await chrome.alarms.create(`${FINAL_SUMMARY_PREFIX}${encoded}`, {
      when: Math.max(finalSummary, Date.now() + 1_000)
    });
  }
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
    if (!/^(preflight|final-preflight|capture|watchdog|recovery-cleanup|ticketnew-final-summary):/.test(alarm.name)) continue;
    const naturalKey = decodeAlarmKey(alarm.name);
    if (naturalKey.split(":")[1] !== dateCode) await chrome.alarms.clear(alarm.name);
  }
}

async function clearDiscoveryRetryAlarmsOutsideDate(dateCode) {
  const alarms = await chrome.alarms.getAll();
  for (const alarm of alarms) {
    if (!alarm.name.startsWith(DISCOVERY_RETRY_PREFIX)) continue;
    if (discoveryRetryDetails(alarm.name).dateCode !== dateCode) await chrome.alarms.clear(alarm.name);
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

async function replaceAgentTab(venue, dateCode) {
  const url = discoveryUrl(venue, dateCode);
  const stored = await chrome.storage.local.get({ agentTabIds: {} });
  const agentTabIds = { ...stored.agentTabIds };
  const oldTabId = agentTabIds[venue.venueCode];
  if (oldTabId) {
    const oldTab = await chrome.tabs.get(oldTabId).catch(() => null);
    if (oldTab && tabBelongsToVenue(oldTab, venue)) await chrome.tabs.remove(oldTabId).catch(() => {});
    delete agentTabIds[venue.venueCode];
    await chrome.storage.local.set({ agentTabIds });
  }
  const tab = await chrome.tabs.create({ url, active: false, pinned: true });
  agentTabIds[venue.venueCode] = tab.id;
  await chrome.storage.local.set({ agentTabIds });
  try {
    await waitForComplete(tab.id);
  } catch (error) {
    throw discoveryTabError(error, "fresh_tab_load", {
      tabId: tab.id,
      tabStatus: error?.tabStatus || null,
      tabUrl: error?.tabUrl || url
    });
  }
  return chrome.tabs.get(tab.id);
}

async function resetAgentTabsForNewDay(dateCode) {
  const stored = await chrome.storage.local.get({
    agentTabIds: {},
    pendingCaptures: {},
    ticketNewLiveUrls: {}
  });
  if (Object.keys(stored.pendingCaptures).length) {
    await appendAgentDiagnostic({ type: "daily_tab_reset_skipped", dateCode, reason: "capture in progress" });
    return false;
  }
  for (const [venueCode, tabId] of Object.entries(stored.agentTabIds)) {
    const venue = VENUE_BY_CODE[venueCode];
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (venue && tab && tabBelongsToVenue(tab, venue)) await chrome.tabs.remove(tabId).catch(() => {});
  }
  const ticketNewLiveUrls = Object.fromEntries(Object.entries(stored.ticketNewLiveUrls)
    .filter(([, entry]) => entry?.dateCode === dateCode));
  await chrome.storage.local.set({ agentTabIds: {}, ticketNewLiveUrls });
  await appendAgentDiagnostic({ type: "daily_tab_reset", dateCode });
  return true;
}

async function openSeatLayout(show) {
  const venue = venueFor(show.venueCode);
  const targetUrl = show.directSeatLayoutUrl || show.seatLayoutUrl;
  const stored = await chrome.storage.local.get({ agentTabIds: {} });
  const agentTabIds = stored.agentTabIds;
  let tab = agentTabIds[show.venueCode]
    ? await chrome.tabs.get(agentTabIds[show.venueCode]).catch(() => null)
    : null;
  if (!tab) {
    tab = await chrome.tabs.create({ url: targetUrl, active: false, pinned: true });
    agentTabIds[show.venueCode] = tab.id;
    await chrome.storage.local.set({ agentTabIds });
  } else if (tab.url === targetUrl) {
    await chrome.tabs.reload(tab.id);
  } else {
    tab = await chrome.tabs.update(tab.id, { url: targetUrl, active: false });
  }
  await waitForComplete(tab.id);
}

async function prepareRecoverySeatLayout(show) {
  const stored = await chrome.storage.local.get({ recoveryTabIds: {} });
  const recoveryTabIds = { ...stored.recoveryTabIds };
  const existingId = recoveryTabIds[show.venueCode];
  if (existingId) await safeRemoveRecoveryTab(existingId, show.venueCode);
  const tab = await chrome.tabs.create({
    url: show.directSeatLayoutUrl || show.seatLayoutUrl,
    active: true,
    pinned: true
  });
  recoveryTabIds[show.venueCode] = tab.id;
  await chrome.storage.local.set({ recoveryTabIds });
  return tab;
}

async function openRecoverySeatLayout(show) {
  const targetUrl = show.directSeatLayoutUrl || show.seatLayoutUrl;
  const stored = await chrome.storage.local.get({ recoveryTabIds: {} });
  const recoveryTabIds = { ...stored.recoveryTabIds };
  let tab = recoveryTabIds[show.venueCode]
    ? await chrome.tabs.get(recoveryTabIds[show.venueCode]).catch(() => null)
    : null;
  if (tab && !tabMatchesRecovery(tab, show.venueCode)) tab = null;
  if (!tab) {
    tab = await chrome.tabs.create({ url: targetUrl, active: true, pinned: true });
    recoveryTabIds[show.venueCode] = tab.id;
    await chrome.storage.local.set({ recoveryTabIds });
  } else if (tab.url === targetUrl) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.tabs.reload(tab.id);
  } else {
    tab = await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
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
  if (tab && tabMatchesRecovery(tab, venueCode)) await chrome.tabs.remove(tabId).catch(() => {});
}

function tabMatchesRecovery(tab, venueCode) {
  return tabBelongsToVenue(
    typeof tab === "string" ? { url: tab } : tab,
    venueFor(venueCode)
  );
}

async function withCachedTicketNewSeatLayout(show) {
  if (show.platform !== "ticketnew") return show;
  const { ticketNewLiveUrls = {} } = await chrome.storage.local.get({ ticketNewLiveUrls: {} });
  const cached = ticketNewLiveUrls[show.naturalKey];
  return cachedTicketNewUrlMatches(cached, show)
    ? { ...show, directSeatLayoutUrl: cached.url }
    : show;
}

function cachedTicketNewUrlMatches(cached, show) {
  if (!cached?.url || cached.dateCode !== show.dateCode || String(cached.sessionId) !== String(show.sessionId)) {
    return false;
  }
  try {
    const url = new URL(cached.url);
    const pathSession = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) || "").toLowerCase();
    const encodedSession = String(url.searchParams.get("encsessionid") || "").toLowerCase();
    const dateCode = String(url.searchParams.get("fromdate") || "").replaceAll("-", "");
    const sessionId = String(show.sessionId).toLowerCase();
    return url.hostname.endsWith("ticketnew.com") &&
      url.pathname.includes("/movies/seat-layout/") &&
      dateCode === show.dateCode &&
      globalThis.SKCTTicketNew.sessionIdentityMatches(pathSession, encodedSession, sessionId);
  } catch {
    return false;
  }
}

async function waitForComplete(tabId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      const error = new Error(`The booking tab ${tabId} was closed before it finished loading`);
      error.tabId = tabId;
      error.tabStatus = "closed";
      throw error;
    }
    if (tab.status === "complete") {
      await delay(800);
      return;
    }
    await delay(250);
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const error = new Error(`The booking tab did not finish loading within 30 seconds`);
  error.tabId = tabId;
  error.tabStatus = tab?.status || "missing";
  error.tabUrl = tab?.pendingUrl || tab?.url || null;
  throw error;
}

function discoveryUrl(venue, dateCode) {
  if (venue.platform === "ticketnew") {
    const date = `${dateCode.slice(0, 4)}-${dateCode.slice(4, 6)}-${dateCode.slice(6, 8)}`;
    return `https://ticketnew.com/movies/madanapalle/${venue.slug}/${venue.cinemaId}?fromdate=${date}`;
  }
  return `https://in.bookmyshow.com/cinemas/mdnp/${venue.slug}/buytickets/${venue.venueCode}/${dateCode}`;
}

function districtDiscoveryUrl(venue, dateCode) {
  if (venue.venueCode !== "SCM" || !venue.districtSlug) {
    throw new Error(`${venue.shortName} does not have a District fallback`);
  }
  const date = `${dateCode.slice(0, 4)}-${dateCode.slice(4, 6)}-${dateCode.slice(6, 8)}`;
  return `https://www.district.in/movies/${venue.districtSlug}?fromdate=${date}`;
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

function discoveryRetryAlarmName(venueCode, dateCode) {
  return `${DISCOVERY_RETRY_PREFIX}${venueCode}:${dateCode}`;
}

function discoveryRetryStorageKey(venueCode, dateCode) {
  return `discoveryFailure:${venueCode}:${dateCode}`;
}

function discoveryRetryDetails(name) {
  const [venueCode = "", dateCode = ""] = name.slice(DISCOVERY_RETRY_PREFIX.length).split(":");
  return { venueCode, dateCode };
}

async function discoveryRetryState(venueCode, dateCode) {
  const key = discoveryRetryStorageKey(venueCode, dateCode);
  return (await chrome.storage.local.get(key))[key] || null;
}

async function scheduleVenueDiscoveryRetry(venueCode, dateCode, error) {
  const key = discoveryRetryStorageKey(venueCode, dateCode);
  const previous = (await chrome.storage.local.get(key))[key] || {};
  const failureCount = Number(previous.failureCount || 0) + 1;
  const delayMs = discoveryRetryDelay(failureCount);
  const retryAt = new Date(Date.now() + delayMs).toISOString();
  const state = {
    failureCount,
    lastFailedAt: new Date().toISOString(),
    retryAt,
    stage: error.discoveryStage || "discovery_tab",
    error: String(error.message || error).slice(0, 500),
    tabRepairAttempted: Boolean(error.tabRepairAttempted)
  };
  await chrome.storage.local.set({ [key]: state });
  await chrome.alarms.create(discoveryRetryAlarmName(venueCode, dateCode), {
    when: new Date(retryAt).getTime()
  });
  await appendAgentDiagnostic({
    type: "discovery_retry_scheduled",
    venueCode,
    dateCode,
    failureCount,
    retryAt,
    stage: state.stage,
    error: state.error
  });
  return state;
}

async function clearVenueDiscoveryFailure(venueCode, dateCode) {
  const key = discoveryRetryStorageKey(venueCode, dateCode);
  const previous = (await chrome.storage.local.get(key))[key];
  await chrome.alarms.clear(discoveryRetryAlarmName(venueCode, dateCode));
  if (!previous) return;
  await chrome.storage.local.remove(key);
  await appendAgentDiagnostic({
    type: "discovery_retry_cleared",
    venueCode,
    dateCode,
    recoveredAfterFailures: Number(previous.failureCount || 0)
  });
}

async function appendAgentDiagnostic(entry) {
  const operation = agentDiagnosticMutation.then(async () => {
    const { agentDiagnostics = [] } = await chrome.storage.local.get({ agentDiagnostics: [] });
    const next = [...agentDiagnostics, { at: new Date().toISOString(), ...entry }].slice(-60);
    await chrome.storage.local.set({ agentDiagnostics: next });
  });
  agentDiagnosticMutation = operation.catch(() => {});
  return operation;
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

async function protectCaptureLocally(entry, stateChanges) {
  const operation = Promise.all([captureOutboxMutation, captureStateMutation]).then(async () => {
    const local = await chrome.storage.local.get({ captureOutbox: {}, captureStates: {} });
    const captureOutbox = { ...local.captureOutbox, [entry.clientCaptureId]: entry };
    const captureStates = {
      ...local.captureStates,
      [entry.show.naturalKey]: {
        ...(local.captureStates[entry.show.naturalKey] || {}),
        ...stateChanges
      }
    };
    await chrome.storage.local.set({ captureOutbox, captureStates });
    return { entry, state: captureStates[entry.show.naturalKey] };
  });
  captureOutboxMutation = operation.catch(() => {});
  captureStateMutation = operation.catch(() => {});
  return operation;
}

async function removeCaptureOutbox(clientCaptureId) {
  return mutateCaptureOutbox((outbox) => {
    const next = { ...outbox };
    delete next[clientCaptureId];
    return next;
  });
}

async function recordCaptureOutboxFailure(entry, error) {
  const attemptedAt = new Date().toISOString();
  return mutateCaptureOutbox((outbox) => {
    if (!outbox[entry.clientCaptureId]) return outbox;
    return {
      ...outbox,
      [entry.clientCaptureId]: {
        ...outbox[entry.clientCaptureId],
        attempts: Number(outbox[entry.clientCaptureId].attempts || 0) + 1,
        lastAttemptAt: attemptedAt,
        lastError: String(error?.message || error).slice(0, 500),
        lastHttpStatus: error?.apiStatus || null,
        lastApiCode: error?.apiCode || null
      }
    };
  });
}

async function mutateCaptureOutbox(update) {
  const operation = captureOutboxMutation.then(async () => {
    const { captureOutbox = {} } = await chrome.storage.local.get({ captureOutbox: {} });
    const next = update(captureOutbox);
    await chrome.storage.local.set({ captureOutbox: next });
    return next;
  });
  captureOutboxMutation = operation.catch(() => {});
  return operation;
}

async function captureOutboxCount(naturalKey = null) {
  await captureOutboxMutation;
  const { captureOutbox = {} } = await chrome.storage.local.get({ captureOutbox: {} });
  return naturalKey
    ? Object.values(captureOutbox).filter((entry) => entry.show?.naturalKey === naturalKey).length
    : Object.keys(captureOutbox).length;
}

async function captureOutboxHas(clientCaptureId) {
  await captureOutboxMutation;
  const { captureOutbox = {} } = await chrome.storage.local.get({ captureOutbox: {} });
  return Boolean(captureOutbox[clientCaptureId]);
}

async function flushCaptureOutbox() {
  if (captureOutboxFlushPromise) return captureOutboxFlushPromise;
  const operation = flushCaptureOutboxUnlocked();
  captureOutboxFlushPromise = operation;
  try {
    return await operation;
  } finally {
    if (captureOutboxFlushPromise === operation) captureOutboxFlushPromise = null;
  }
}

async function flushCaptureOutboxUnlocked() {
  await captureOutboxMutation;
  const { captureOutbox = {} } = await chrome.storage.local.get({ captureOutbox: {} });
  const entries = orderedCaptureOutbox(captureOutbox);
  for (const entry of entries) {
    let saved;
    try {
      saved = await apiPost("/api/agent/capture", entry.payload);
    } catch (error) {
      await recordCaptureOutboxFailure(entry, error);
      const pendingCount = await captureOutboxCount();
      await updateCaptureState(entry.show.naturalKey, {
        outboxPending: true,
        lastUploadError: String(error?.message || error).slice(0, 500),
        lastUploadAttemptAt: new Date().toISOString()
      });
      await chrome.storage.local.set({
        status: {
          ok: false,
          message: `Capture safe locally · ${pendingCount} upload${pendingCount === 1 ? "" : "s"} pending · ${error.message}`,
          at: new Date().toISOString()
        },
        captureOutboxCount: pendingCount
      });
      await appendAgentDiagnostic({
        type: "capture_upload_deferred",
        naturalKey: entry.show.naturalKey,
        clientCaptureId: entry.clientCaptureId,
        status: error?.apiStatus || null,
        code: error?.apiCode || null,
        error: String(error?.message || error).slice(0, 500)
      });
      if (!error?.apiStatus || error.apiStatus === 401 || error.apiStatus === 403 ||
        error.apiStatus === 429 || error.apiStatus >= 500) break;
      continue;
    }

    await removeCaptureOutbox(entry.clientCaptureId);
    const remainingForShow = await captureOutboxCount(entry.show.naturalKey);
    const remainingTotal = await captureOutboxCount();
    const estimated = isTicketNewSummary(entry.payload);
    await updateCaptureState(entry.show.naturalKey, estimated ? {
      lastEstimateSuccessAt: entry.payload.capturedAt,
      lastEstimateUploadAt: new Date().toISOString(),
      lastUploadError: null,
      outboxPending: remainingForShow > 0
    } : {
      lastSuccessAt: entry.payload.capturedAt,
      lastLiveSuccessAt: entry.payload.capturedAt,
      lastSuccessAttemptId: entry.payload.attemptId || entry.clientCaptureId,
      lastUploadAt: new Date().toISOString(),
      lastUploadError: null,
      outboxPending: remainingForShow > 0
    });
    await scheduleShow(entry.show);
    const venue = venueFor(entry.show.venueCode);
    const kind = captureKind(entry.show, entry.payload);
    await recordSuccess(
      `${kind} capture uploaded for ${venue.shortName} ${entry.show.showTimeLabel}: ${saved.sold} tickets${saved.duplicate ? " (already saved)" : ""}`,
      { lastCapture: saved, captureOutboxCount: remainingTotal }
    );
    await appendAgentDiagnostic({
      type: "capture_upload_completed",
      naturalKey: entry.show.naturalKey,
      clientCaptureId: entry.clientCaptureId,
      duplicate: Boolean(saved.duplicate),
      queuedAt: entry.queuedAt,
      capturedAt: entry.payload.capturedAt
    });
    await notify(
      `${kind} capture uploaded`,
      `${venue.shortName} · ${entry.show.showTimeLabel} · ${saved.sold} tickets · ₹${Math.round(saved.collectionPaise / 100).toLocaleString("en-IN")}`
    );
  }
  return { pending: await captureOutboxCount() };
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
  if (!response.ok) {
    const error = new Error(data.message || data.error || `API returned ${response.status}`);
    error.apiStatus = response.status;
    error.apiCode = data.error || null;
    throw error;
  }
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
