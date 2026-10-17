import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepFinished, staleMatchdays } from '../src/data/repair.ts';
import { match, team } from './helpers.ts';

const a = team(1);
const b = team(2);

test('jogo encerrado não volta a ficar sem resultado', () => {
  const done = match(30, a, b, [2, 1]);
  const memory = new Map();
  assert.equal(keepFinished([done], memory).learned, true);

  const glitch = { ...done, status: 'SCHEDULED' as const, homeGoals: null, awayGoals: null };
  const { matches, learned } = keepFinished([glitch], memory);
  assert.deepEqual(matches, [done]);
  assert.equal(learned, false);
});

test('placar corrigido pela fonte substitui o guardado', () => {
  const memory = new Map();
  const done = match(30, a, b, [2, 1]);
  keepFinished([done], memory);
  const fixed = { ...done, homeGoals: 3 };
  assert.equal(keepFinished([fixed], memory).learned, true);
  assert.equal(memory.get(done.id).homeGoals, 3);
});

test('rodada com jogo antigo sem resultado é marcada para buscar de novo, menos os adiados', () => {
  const old = match(30, a, b); // sem placar, data no passado
  const postponed = match(21, b, a);
  const future = { ...match(40, a, b), utcDate: new Date(Date.now() + 86_400_000).toISOString() };
  assert.deepEqual(staleMatchdays([old, postponed, future], new Set([postponed.id])), [30]);
});
