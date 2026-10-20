import { collectorSettings, DEFAULT_API_BASE, ensureAgentIdentity } from "./agent-settings.js";

const connectPanel = document.querySelector("#connectPanel");
const controlPanel = document.querySelector("#controlPanel");
const status = document.querySelector("#status");

document.querySelector("#connect").addEventListener("click", connectLaptop);
document.querySelector("#saveName").addEventListener("click", saveName);
document.querySelector("#makePrimary").addEventListener("click", makePrimary);
document.querySelector("#test").addEventListener("click", testCollector);
document.querySelector("#enabled").addEventListener("change", toggleCollector);
restore();

const element = (id) => document.querySelector(id);
function setStatus(message, ok = null) {
  status.textContent = message;
  if (ok == null) delete status.dataset.ok;
  else status.dataset.ok = String(ok);
}

async function connectLaptop() {
  const name = element("#connectName").value.trim();
  const code = element("#connectionCode").value.trim();
  if (!name || !code) return setStatus("Enter a laptop name and connection code.", false);
  setStatus("Connecting this laptop…");
  const identity = await ensureAgentIdentity();
  const base = (element("#connectApiBase").value.trim() || DEFAULT_API_BASE).replace(/\/$/, "");
  try {
    const response = await fetch(`${base}/api/agent/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: identity.agentId, name, connectionCode: code })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || `Connection failed (${response.status})`);
    await chrome.storage.sync.set({ apiBase: base });
    await chrome.storage.local.set({
      agentToken: result.agentToken,
      agentName: result.name,
      rolePriority: result.rolePriority,
      collectorCredentialVersion: 2,
      enabled: false,
      localSettingsMigrated: true
    });
    element("#connectionCode").value = "";
    await restore();
    setStatus("Connected. Turn this collector On when you need it.", true);
  } catch (error) {
    setStatus(error.message, false);
  }
}

async function toggleCollector() {
  const enabled = element("#enabled");
  enabled.disabled = true;
  await chrome.storage.local.set({ enabled: enabled.checked, localSettingsMigrated: true });
  const result = await chrome.runtime.sendMessage({ type: "SETTINGS_UPDATED" });
  enabled.disabled = false;
  if (!result?.ok) {
    enabled.checked = !enabled.checked;
    await chrome.storage.local.set({ enabled: enabled.checked });
    return setStatus(`Could not change collector: ${result?.error || "unknown error"}`, false);
  }
  setStatus(enabled.checked
    ? "Collector is On. Discovery is running now and captures are protected."
    : "Collector is Off on this laptop. Saved uploads will still finish safely.", true);
}

async function saveName() {
  const name = element("#deviceName").value.trim();
  if (!name) return setStatus("Enter a laptop name.", false);
  await chrome.storage.local.set({ agentName: name });
  await chrome.runtime.sendMessage({ type: "SETTINGS_UPDATED" }).catch(() => null);
  element("#deviceTitle").textContent = name;
  setStatus("Laptop name saved.", true);
}

async function apiPost(path, body = {}) {
  const settings = await collectorSettings();
  const { agentToken = "" } = await chrome.storage.local.get({ agentToken: "" });
  const response = await fetch(`${settings.apiBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || `API returned ${response.status}`);
  return result;
}

async function makePrimary() {
  try {
    await apiPost("/api/agent/primary");
    await chrome.storage.local.set({ rolePriority: 10 });
    element("#deviceRole").textContent = "Primary collector";
    setStatus("This laptop is now Primary. Other On laptops remain ready as backups.", true);
  } catch (error) {
    setStatus(error.message, false);
  }
}

async function testCollector() {
  if (!element("#enabled").checked) return setStatus("Turn this collector On before testing.", false);
  setStatus("Testing all four theatres…");
  const result = await chrome.runtime.sendMessage({ type: "RUN_DISCOVERY" });
  setStatus(result.ok
    ? `Working: ${result.result.shows} shows found across ${result.result.venues.length} theatres.`
    : `Needs attention: ${result.error}`, result.ok);
}

async function restore() {
  const settings = await collectorSettings();
  const local = await chrome.storage.local.get({
    agentToken: "",
    agentName: settings.agentName,
    rolePriority: 100,
    status: null,
    captureOutbox: {}
  });
  const connected = Boolean(local.agentToken);
  connectPanel.hidden = connected;
  controlPanel.hidden = !connected;
  element("#connectApiBase").value = settings.apiBase || DEFAULT_API_BASE;
  element("#connectName").value = local.agentName;
  element("#deviceName").value = local.agentName;
  element("#deviceTitle").textContent = local.agentName;
  element("#deviceRole").textContent = Number(local.rolePriority) <= 10 ? "Primary collector" : "Backup collector";
  element("#enabled").checked = settings.enabled;
  if (local.status) {
    const pending = Object.keys(local.captureOutbox).length;
    setStatus(`${local.status.message} · ${new Date(local.status.at).toLocaleString()}${pending ? ` · ${pending} upload pending` : ""}`, local.status.ok);
  } else if (!connected) {
    setStatus("Connect once. This laptop will stay paired until you remove the extension.");
  }
}
