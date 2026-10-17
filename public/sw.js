// Service worker mínimo: só existe para mostrar as notificações de gol (inclusive
// as que o servidor manda com o celular bloqueado) e abrir o painel no toque.
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

// Notificação mandada pelo servidor (Web Push)
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: event.data?.text() };
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Painel aberto na tela: o aviso já aparece na própria página
      if (clients.some((c) => c.visibilityState === 'visible')) return;
      return self.registration.showNotification(data.title || 'Painel do futebol', {
        body: data.body,
        icon: data.icon || 'icone.svg',
        badge: 'icone.svg',
        tag: data.tag,
        renotify: true,
        data: { url: data.url || '/' },
      });
    }),
  );
});

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
