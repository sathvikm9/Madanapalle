const form = document.querySelector("#settings");
const apiBase = document.querySelector("#apiBase");
const agentToken = document.querySelector("#agentToken");
const enabled = document.querySelector("#enabled");
const status = document.querySelector("#status");

restore();
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await save();
  status.textContent = "Settings saved.";
  status.dataset.ok = "true";
});
document.querySelector("#test").addEventListener("click", async () => {
  await save();
  status.textContent = "Opening all four theatre tabs and testing discovery…";
  const result = await chrome.runtime.sendMessage({ type: "RUN_DISCOVERY" });
  status.textContent = result.ok
    ? `Working: discovered ${result.result.shows} shows across ${result.result.venues.length} theatres.`
    : `Needs attention: ${result.error}`;
  status.dataset.ok = String(result.ok);
});

async function save() {
  await chrome.storage.sync.set({
    apiBase: apiBase.value.trim().replace(/\/$/, ""),
    enabled: enabled.checked
  });
  await chrome.storage.local.set({ agentToken: agentToken.value.trim() });
}

async function restore() {
  const settings = await chrome.storage.sync.get({ apiBase: "", enabled: false });
  const secrets = await chrome.storage.local.get({ agentToken: "" });
  apiBase.value = settings.apiBase;
  agentToken.value = secrets.agentToken;
  enabled.checked = settings.enabled;
  const local = await chrome.storage.local.get("status");
  if (local.status) {
    status.textContent = `${local.status.message} · ${new Date(local.status.at).toLocaleString()}`;
    status.dataset.ok = String(local.status.ok);
  }
}
