const APP_PATH = self.registration.scope;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {
    payload = { title: "Show update", body: event.data?.text() || "New collection update" };
  }
  const title = payload.title || "Show update";
  event.waitUntil(self.registration.showNotification(title, {
    body: payload.body || "New collection update",
    icon: new URL("icons/icon-192.png", APP_PATH).href,
    badge: new URL("icons/icon-192.png", APP_PATH).href,
    tag: payload.tag || `mpltalkies-${Date.now()}`,
    renotify: false,
    data: { url: payload.url || "./" }
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./", APP_PATH).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === new URL(target).origin);
    if (existing) {
      await existing.navigate(target);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  })());
});
