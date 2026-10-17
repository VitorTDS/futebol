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
