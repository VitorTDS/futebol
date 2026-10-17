import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resilient } from '../src/data/resilient.ts';
import type { DataProvider, Match } from '../src/types.ts';
import { match, team } from './helpers.ts';

function flaky() {
  let fail = false;
  const games: Match[] = [match(1, team(1), team(2), [1, 0])];
  const provider: DataProvider = {
    name: 'teste',
    getMatches: async () => {
      if (fail) throw new Error('fora do ar');
      return games;
    },
    getScorers: async () => null,
    getPreviousSeasons: async () => [],
  };
  return { provider, setFail: (v: boolean) => (fail = v) };
}

test('fonte cai: segue com os últimos placares e avisa desde quando', async () => {
  const { provider, setFail } = flaky();
  const p = resilient(provider, 'teste');
  const before = await p.getMatches();
  assert.equal(p.health().ok, true);

  setFail(true);
  const during = await p.getMatches();
  assert.deepEqual(during, before);
  const h = p.health();
  assert.equal(h.ok, false);
  assert.equal(h.error, 'fora do ar');
  assert.ok(h.failingSince && h.lastOk);

  setFail(false);
  await p.getMatches();
  assert.equal(p.health().ok, true);
});

test('fonte que nunca respondeu: o erro aparece (não há placar antigo para mostrar)', async () => {
  const { provider, setFail } = flaky();
  setFail(true);
  await assert.rejects(resilient(provider, 'teste').getMatches(), /fora do ar/);
});
