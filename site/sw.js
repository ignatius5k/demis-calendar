self.addEventListener("push", (event) => {
  let message = {};
  try { message = event.data?.json() || {}; } catch { /* Use the generic text below. */ }
  event.waitUntil(self.registration.showNotification(message.title || "Demi’s Calendar", {
    body: message.body || "You have a new calendar update.",
    icon: "./assets/icon-192.png",
    tag: message.id || "demi-calendar",
    data: { url: new URL("./#host", self.registration.scope).href },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL("./#host", self.registration.scope);
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(self.registration.scope));
    if (!existing) return self.clients.openWindow(url.href);
    await existing.navigate(url.href);
    return existing.focus();
  })());
});
