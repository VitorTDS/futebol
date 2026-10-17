import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMatchTime, liveEvents } from '../src/model/liveEvents.ts';
import type { Match } from '../src/types.ts';
import { match, team } from './helpers.ts';

const a = team(1, 'AAA');
const b = team(2, 'BBB');

const at = (m: Match, changes: Partial<Match>): Match => ({ ...m, ...changes });

test('gol do visitante durante o jogo', () => {
  const m = match(1, a, b, [1, 0], 'LIVE');
  const ev = liveEvents([m], [at(m, { awayGoals: 1, minute: 70 })]);
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].type, ev[0].type === 'goal' && ev[0].side, ev[0].type === 'goal' && ev[0].minute], ['goal', 'away', 70]);
});

test('dois gols entre leituras viram dois eventos', () => {
  const m = match(1, a, b, [0, 0], 'LIVE');
  assert.equal(liveEvents([m], [at(m, { homeGoals: 2 })]).length, 2);
});

test('início e fim de jogo', () => {
  const m = match(1, a, b);
  const live = at(m, { status: 'LIVE', homeGoals: 0, awayGoals: 0 });
  assert.deepEqual(liveEvents([m], [live]).map((e) => e.type), ['kickoff']);
  const end = at(live, { status: 'FINISHED' });
  assert.deepEqual(liveEvents([live], [end]).map((e) => e.type), ['fulltime']);
});

test('gol anulado (placar diminui) não gera alerta', () => {
  const m = match(1, a, b, [1, 0], 'LIVE');
  assert.equal(liveEvents([m], [at(m, { homeGoals: 0 })]).length, 0);
});

test('jogo que aparece já encerrado não gera gol', () => {
  const m = match(1, a, b);
  assert.equal(liveEvents([m], [at(m, { status: 'FINISHED', homeGoals: 3, awayGoals: 1 })]).length, 0);
});

test('hora de jogo: perto do início ou rolando', () => {
  const m = match(1, a, b);
  const kickoff = Date.parse(m.utcDate);
  assert.equal(isMatchTime([m], kickoff - 60 * 60_000), false);
  assert.equal(isMatchTime([m], kickoff - 2 * 60_000), true);
  assert.equal(isMatchTime([at(m, { status: 'LIVE' })], kickoff + 300 * 60_000), true);
});
