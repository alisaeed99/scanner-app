// Service worker for ChartsWatcher Dashboard's Web Push notifications.

const CACHE_NAME = 'charts-watcher-v2';

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
    tag: data.tag || undefined,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Clicking the notification focuses an existing dashboard tab if one is open, or opens a new one otherwise.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow("/scanner-app/");
    })
  );
});
