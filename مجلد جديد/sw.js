// Service worker for ChartsWatcher Dashboard's Web Push notifications.
//
// This file runs separately from the dashboard's normal JavaScript —
// it's the piece the browser keeps alive in the background so a push
// message can trigger a notification even when the dashboard tab (or
// installed app icon) is fully closed. This is the fundamental thing
// the browser's local Notification API (`new Notification(...)` called
// directly from the page) cannot do — that only ever works while the
// tab is actually open and running.
//
// Must be hosted at the ROOT of your site (same level as dashboard.html),
// e.g. https://your-site.netlify.app/sw.js — a service worker can only
// control pages at its own path or below.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "ChartsWatcher Alert", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "ChartsWatcher Alert";
  const options = {
    body: data.body || "",
    icon: data.icon || undefined,
    badge: data.badge || undefined,
    tag: data.tag || undefined, // same tag replaces a prior notification instead of stacking
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Clicking the notification focuses an existing dashboard tab if one is
// open, or opens a new one otherwise.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow("/");
    })
  );
});
