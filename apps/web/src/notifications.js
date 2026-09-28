export const DEFAULT_NOTIFICATION_PREFERENCES = {
  venues: ["SKMD", "SCM", "RTDM", "ASRM"],
  types: ["period_results", "schedule_changes", "daily_summary"]
};

const PREFERENCES_KEY = "mpltalkies-notification-preferences";

function base64UrlToUint8Array(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export function notificationSupport() {
  const ios = /iphone|ipad|ipod/i.test(window.navigator.userAgent)
    || (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches
    || window.navigator.standalone === true;
  return {
    supported: "serviceWorker" in window.navigator && "PushManager" in window && "Notification" in window,
    ios,
    standalone,
    requiresInstall: ios && !standalone
  };
}

export function loadNotificationPreferences() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(PREFERENCES_KEY));
    if (Array.isArray(stored?.venues) && Array.isArray(stored?.types)) return stored;
  } catch {
    // Defaults keep the settings usable when local storage is unavailable.
  }
  return DEFAULT_NOTIFICATION_PREFERENCES;
}

export function storeNotificationPreferences(preferences) {
  try {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // The server subscription remains the source of truth.
  }
}

export async function registerMplServiceWorker() {
  if (!("serviceWorker" in window.navigator)) return null;
  return window.navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
    scope: import.meta.env.BASE_URL
  });
}

export async function currentPushSubscription() {
  if (!("serviceWorker" in window.navigator)) return null;
  const registration = await window.navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

function deviceName() {
  if (/iphone/i.test(window.navigator.userAgent)) return "iPhone PWA";
  if (/ipad/i.test(window.navigator.userAgent)) return "iPad PWA";
  if (/android/i.test(window.navigator.userAgent)) return "Android PWA";
  return "Web browser";
}

async function saveSubscription(apiBase, subscription, preferences) {
  const response = await fetch(`${apiBase}/api/notifications/subscriptions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subscription: subscription.toJSON(),
      preferences,
      deviceName: deviceName()
    })
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(result?.message || `Notification API returned ${response.status}`);
  }
  storeNotificationPreferences(preferences);
  return response.json();
}

export async function enablePushNotifications(apiBase, publicKey, preferences) {
  const support = notificationSupport();
  if (!support.supported) throw new Error("Push notifications are not supported on this device.");
  if (support.requiresInstall) throw new Error("Add MPLTalkies to your iPhone Home Screen before enabling notifications.");
  const permission = await window.Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not allowed.");
  const registration = await window.navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array(publicKey)
  });
  await saveSubscription(apiBase, subscription, preferences);
  return subscription;
}

export async function updatePushPreferences(apiBase, subscription, preferences) {
  await saveSubscription(apiBase, subscription, preferences);
}

export async function disablePushNotifications(apiBase, subscription) {
  if (!subscription) return;
  await fetch(`${apiBase}/api/notifications/subscriptions`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint })
  });
  await subscription.unsubscribe();
}

export async function showTestNotification({ title, body, tag = "preview" }) {
  const registration = await window.navigator.serviceWorker.ready;
  await registration.showNotification(title, {
    body,
    icon: `${import.meta.env.BASE_URL}icons/icon-192.png`,
    badge: `${import.meta.env.BASE_URL}icons/icon-192.png`,
    tag: `mpltalkies-test-${tag}`,
    data: { url: "./" }
  });
}
