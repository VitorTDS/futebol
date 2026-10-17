import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFootballDataProvider } from '../src/data/footballData.ts';

test('limite de requisições (429): espera o tempo que a API pede e tenta de novo', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return new Response('{"message":"You reached your request limit. Wait 0 seconds."}', { status: 429 });
    return new Response(JSON.stringify({ scorers: [] }), { status: 200 });
  }) as typeof fetch;
  const provider = createFootballDataProvider({ token: 'x', competition: 'TESTE' });
  assert.deepEqual(await provider.getScorers(), []);
  assert.equal(calls, 2);
});
