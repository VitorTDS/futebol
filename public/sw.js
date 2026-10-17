// Service worker do painel: notificações de gol (inclusive as que o servidor manda
// com o celular bloqueado) e uma cópia dos dados para abrir sem internet.
//
// Cópia sem internet: tudo do próprio painel (página, código, dados da API) vem
// SEMPRE da rede quando ela responde; a cópia guardada só é usada se a rede falhar
// ou demorar demais. Assim o painel nunca fica preso numa versão velha.

const CACHE = 'painel-v1';
// Rede lenta: depois disso, usa a cópia (a resposta da rede ainda atualiza a cópia quando chegar)
const PAGE_TIMEOUT_MS = 3500;
const API_TIMEOUT_MS = 6000;
// Coisas que nunca mudam (biblioteca com versão no endereço, fontes, escudos): cópia primeiro
const IMMUTABLE = [/^https:\/\/cdnjs\.cloudflare\.com\//, /^https:\/\/fonts\.(googleapis|gstatic)\.com\//, /^https:\/\/crests\.football-data\.org\//, /^https:\/\/a\.espncdn\.com\//];
// Respostas que não fazem sentido guardar
const NEVER = ['/api/stream', '/api/push/', '/api/health', '/api/status'];

self.addEventListener('install', () => self.skipWaiting());

// Apaga caches de outros apps que já rodaram neste endereço (eles entregavam páginas
// velhas no lugar das novas) e versões antigas do nosso
self.addEventListener('activate', (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  ),
);

/** Guarda uma cópia com a hora em que foi salva (a página mostra "dados de 14:32") */
async function save(request, response) {
  if (!response.ok && response.type !== 'opaque') return;
  const cache = await caches.open(CACHE);
  if (response.type === 'opaque') return cache.put(request, response);
  const headers = new Headers(response.headers);
  headers.set('x-painel-salvo', new Date().toISOString());
  const body = await response.blob();
  await cache.put(request, new Response(body, { status: response.status, statusText: response.statusText, headers }));
}

/** Cópia guardada, marcada como "sem internet" para a página avisar */
async function fromCache(request) {
  const hit = await caches.match(request);
  if (!hit) return null;
  if (hit.type === 'opaque') return hit;
  const headers = new Headers(hit.headers);
  headers.set('x-painel-offline', hit.headers.get('x-painel-salvo') || '1');
  return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers });
}

/** Rede primeiro; se falhar ou passar do tempo, a cópia. Sem cópia, espera a rede mesmo. */
async function networkFirst(event, timeoutMs) {
  const request = event.request;
  const network = fetch(request).then((response) => {
    event.waitUntil(save(request, response.clone()).catch(() => {}));
    return response;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs, 'timeout'));
  try {
    const first = await Promise.race([network, timeout]);
    if (first !== 'timeout') return first;
    return (await fromCache(request)) ?? (await network);
  } catch {
    const cached = await fromCache(request);
    if (cached) return cached;
    throw new Error('sem rede e sem cópia');
  }
}

async function cacheFirst(event) {
  const hit = await caches.match(event.request);
  if (hit) return hit;
  const response = await fetch(event.request);
  event.waitUntil(save(event.request, response.clone()).catch(() => {}));
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (IMMUTABLE.some((re) => re.test(request.url))) {
    event.respondWith(cacheFirst(event));
    return;
  }
  if (url.origin !== self.location.origin || NEVER.some((p) => url.pathname.startsWith(p))) return;
  event.respondWith(networkFirst(event, url.pathname.startsWith('/api/') ? API_TIMEOUT_MS : PAGE_TIMEOUT_MS));
});

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
