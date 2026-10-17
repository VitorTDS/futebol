// Service worker mínimo: só existe para mostrar as notificações de gol e
// abrir o painel quando a pessoa toca nelas.
self.addEventListener('install', () => self.skipWaiting());

// O painel não guarda nada em cache: apaga caches deixados por outros apps que já
// rodaram neste mesmo endereço (eles entregavam páginas velhas no lugar das novas)
self.addEventListener('activate', (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  ),
);

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const open = clients.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) {
        open.navigate(url);
        return open.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
