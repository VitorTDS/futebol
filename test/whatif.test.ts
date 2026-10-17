import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mulberry32 } from '../src/model/random.ts';
import { simulateSeason } from '../src/model/simulation.ts';
import { applyPick, pickedScores } from '../src/model/whatif.ts';
import { match, team } from './helpers.ts';

const a = team(1);
const b = team(2);

test('palpite em jogo por disputar vira placar mínimo', () => {
  const m = match(1, a, b);
  assert.deepEqual([applyPick(m, 'H').homeGoals, applyPick(m, 'H').awayGoals], [1, 0]);
  assert.deepEqual([applyPick(m, 'D').homeGoals, applyPick(m, 'D').awayGoals], [0, 0]);
  assert.deepEqual([applyPick(m, 'A').homeGoals, applyPick(m, 'A').awayGoals], [0, 1]);
  assert.equal(applyPick(m, 'H').status, 'FINISHED');
});

test('palpite em jogo ao vivo parte do placar atual', () => {
  const live = match(1, a, b, [0, 2], 'LIVE');
  assert.deepEqual([applyPick(live, 'H').homeGoals, applyPick(live, 'H').awayGoals], [3, 2]);
  assert.deepEqual([applyPick(live, 'D').homeGoals, applyPick(live, 'D').awayGoals], [2, 2]);
  assert.deepEqual([applyPick(live, 'A').homeGoals, applyPick(live, 'A').awayGoals], [0, 2]);
});

test('jogo encerrado e palpite inválido são ignorados', () => {
  const done = match(1, a, b, [2, 2]);
  const open = match(2, b, a);
  const other = match(3, a, b);
  const out = pickedScores([done, open, other], { [done.id]: 'H', [open.id]: 'X', [other.id]: 'A' });
  assert.deepEqual([...out], [[other.id, [0, 1]]]);
});

test('sem palpites, o "e se" dá exatamente o cenário-base (mesma semente)', () => {
  const teams = [team(1), team(2), team(3), team(4)];
  const matches = [match(1, teams[0], teams[1]), match(1, teams[2], teams[3]), match(2, teams[0], teams[2]), match(2, teams[1], teams[3])];
  const model = { kind: 'poisson' as const, rho: 0, expectedGoals: () => ({ home: 1.4, away: 1.1 }) };
  const zones = { libertadores: 1, sulamericana: 1, relegation: 1 };
  const run = (forced?: Map<number, [number, number]>) =>
    simulateSeason(teams, matches, model, { runs: 500, zones, rng: mulberry32(9), forced }).teams.map((t) => t.title);
  assert.deepEqual(run(), run(new Map()));
  // Fixar um jogo muda o resultado, mas sem desalinhar os sorteios dos outros
  assert.notDeepEqual(run(), run(new Map([[matches[0].id, [5, 0]]])));
});
