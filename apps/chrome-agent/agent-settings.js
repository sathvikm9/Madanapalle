export const DEFAULT_API_BASE = "https://sri-krishna-tracker-api.skct-worker.workers.dev";

export async function invalidateAgentAuthorization(message = "This laptop's saved connection is no longer accepted.") {
  const at = new Date().toISOString();
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

export async function collectorSettings() {
  const synced = await chrome.storage.sync.get({ apiBase: DEFAULT_API_BASE, enabled: undefined });
  const local = await chrome.storage.local.get({
    enabled: undefined,
    localSettingsMigrated: false,
    agentId: "",
    agentName: "My laptop"
  });
  let enabled = local.enabled;
  if (!local.localSettingsMigrated) {
    enabled = typeof local.enabled === "boolean" ? local.enabled : synced.enabled === true;
    await chrome.storage.local.set({ enabled, localSettingsMigrated: true });
    await chrome.storage.sync.remove("enabled");
  }
  const identity = await ensureAgentIdentity();
  return {
    apiBase: String(synced.apiBase || DEFAULT_API_BASE).replace(/\/$/, ""),
    enabled: enabled === true,
    ...identity
  };
}
