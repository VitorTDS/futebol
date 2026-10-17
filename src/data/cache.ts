const store = new Map<string, { expires: number; value: Promise<unknown> }>();

/** Guarda o resultado de `fn` por `ttlMs` (evita estourar o limite da API). */
export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;

  const value = fn();
  store.set(key, { expires: Date.now() + ttlMs, value });
  value.catch(() => store.delete(key));
  return value;
}

const fresh = new Map<string, { expires: number; value?: unknown; pending?: Promise<unknown>; failed?: boolean }>();

/**
 * Como `cached`, mas quando vence devolve na hora o valor que já tem e busca o
 * novo em segundo plano: a página não fica esperando a API a cada minuto.
 * `force` busca agora e espera (é o que o "ao vivo" usa, para não perder tempo
 * nos gols). Se a última busca falhou, espera a próxima, para o erro aparecer.
 */
export function cachedFresh<T>(key: string, ttlMs: number, fn: () => Promise<T>, force = false): Promise<T> {
  let entry = fresh.get(key);
  if (!entry) {
    entry = { expires: 0 };
    fresh.set(key, entry);
  }
  const e = entry;
  const run = () => {
    e.pending ??= fn()
      .then((v) => {
        Object.assign(e, { value: v, expires: Date.now() + ttlMs, failed: false });
        return v;
      })
      .catch((err) => {
        e.failed = true;
        throw err;
      })
      .finally(() => (e.pending = undefined));
    return e.pending as Promise<T>;
  };
  if (force || e.value === undefined || e.failed) return run();
  if (Date.now() > e.expires) run().catch(() => {});
  return Promise.resolve(e.value as T);
}
