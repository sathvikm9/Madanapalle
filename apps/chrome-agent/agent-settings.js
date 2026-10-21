export const DEFAULT_API_BASE = "https://sri-krishna-tracker-api.skct-worker.workers.dev";

export async function invalidateAgentAuthorization(message = "This laptop's saved connection is no longer accepted.") {
  const at = new Date().toISOString();
  chrome.power?.releaseKeepAwake?.();
  await chrome.storage.local.remove(["agentToken", "collectorCredentialVersion", "lastHeartbeatAt"]);
  await chrome.storage.local.set({
    agentAuthorizationInvalid: { message, at },
    enabled: false,
    localSettingsMigrated: true,
    status: {
      ok: false,
      message: "Reconnect this laptop to resume collection.",
      at
    }
  });
}

export async function ensureAgentIdentity() {
  const local = await chrome.storage.local.get({ agentId: "", agentName: "" });
  const agentId = local.agentId || crypto.randomUUID();
  const agentName = local.agentName || "My laptop";
  if (!local.agentId || !local.agentName) await chrome.storage.local.set({ agentId, agentName });
  return { agentId, agentName };
}

export async function migrateCollectorSettings() {
  const synced = await chrome.storage.sync.get({ apiBase: DEFAULT_API_BASE, enabled: undefined });
  const local = await chrome.storage.local.get({
    enabled: undefined,
    localSettingsMigrated: false
  });
  if (!local.localSettingsMigrated) {
    const enabled = typeof local.enabled === "boolean" ? local.enabled : synced.enabled === true;
    await chrome.storage.local.set({ enabled, localSettingsMigrated: true });
    await chrome.storage.sync.remove("enabled");
  }
}

// Periodic alarms use this side-effect-free read. Identity creation and legacy
// migration belong to startup/options flows, not the heartbeat hot path.
export async function collectorRuntimeSettings() {
  const [synced, local] = await Promise.all([
    chrome.storage.sync.get({ apiBase: DEFAULT_API_BASE }),
    chrome.storage.local.get({ enabled: false, agentId: "", agentName: "My laptop" })
  ]);
  return {
    apiBase: String(synced.apiBase || DEFAULT_API_BASE).replace(/\/$/, ""),
    enabled: local.enabled === true,
    agentId: local.agentId,
    agentName: local.agentName || "My laptop"
  };
}

export async function collectorSettings() {
  await migrateCollectorSettings();
  const identity = await ensureAgentIdentity();
  const settings = await collectorRuntimeSettings();
  return {
    ...settings,
    ...identity
  };
}
