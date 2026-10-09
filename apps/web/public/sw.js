// Sitspot service worker: Web Push only (no offline caching).
// Payload JSON: { title, body, url }  — url usually "/call/<invitationId>".
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data && event.data.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Sitspot", {
      body: data.body || "One of your places is calling.",
      icon: "/icon.svg",
      data: { url: data.url || "/" },
      // As attention-grabbing as a web notification can be: long buzz, stays until acted on,
      // re-alerts if a newer invitation replaces an older one. (Browsers can't play a ringtone.)
      tag: "sitspot-invitation",
      renotify: true,
      requireInteraction: true,
      vibrate: [600, 250, 600, 250, 600, 250, 1200],
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) if (w.url === url && "focus" in w) return w.focus();
      return self.clients.openWindow(url);
    }),
  );
});
