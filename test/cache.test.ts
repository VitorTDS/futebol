import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cachedFresh } from '../src/data/cache.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('vencido: devolve o valor antigo na hora e atualiza em segundo plano', async () => {
  let n = 0;
  const fn = async () => {
    await wait(20);
    return ++n;
  };
  assert.equal(await cachedFresh('a', 10, fn), 1); // primeira vez espera
  await wait(15); // venceu
  const t0 = Date.now();
  assert.equal(await cachedFresh('a', 10, fn), 1, 'valor antigo, sem esperar');
  assert.ok(Date.now() - t0 < 15);
  await wait(30); // a busca em segundo plano terminou
  assert.equal(await cachedFresh('a', 10_000, fn), 2);
  // force: busca agora e espera
  assert.equal(await cachedFresh('a', 10_000, fn, true), 3);
});

test('busca que falhou: a próxima leitura espera (para o erro aparecer)', async () => {
  let fail = false;
  const fn = async () => {
    if (fail) throw new Error('fora do ar');
    return 'ok';
  };
  assert.equal(await cachedFresh('b', 1, fn), 'ok');
  fail = true;
  await wait(5);
  assert.equal(await cachedFresh('b', 1, fn), 'ok'); // dispara a busca, que falha
  await wait(5);
  await assert.rejects(cachedFresh('b', 1, fn), /fora do ar/);
});
