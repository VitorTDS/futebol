import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBracket, simulateKnockout } from '../src/model/knockout.ts';
import type { FittedModel } from '../src/model/prediction.ts';
import { mulberry32 } from '../src/model/random.ts';
import type { Match, Team } from '../src/types.ts';
import { match, team } from './helpers.ts';

const [a, b, c, d] = [team(1), team(2), team(3), team(4)];
const tbd = (id: number): Team => ({ id, name: 'A definir', shortName: 'A definir', tla: '?', tbd: true });
const ko = (stage: string, m: Match, penalties?: [number, number]): Match => ({ ...m, stage, penalties: penalties ?? null });
// Jogo ainda por disputar: data no futuro
const soon = (m: Match): Match => ({ ...m, utcDate: new Date(Date.now() + 86_400_000).toISOString() });

const model: FittedModel = { kind: 'poisson', rho: 0, expectedGoals: () => ({ home: 1.3, away: 1.0 }) };

test('confronto de ida e volta: soma os gols e define quem passou', () => {
  const bracket = buildBracket([ko('SEMI_FINALS', match(1, a, b, [1, 2])), ko('SEMI_FINALS', match(2, b, a, [0, 0]))]);
  const [t] = bracket.get('SEMI_FINALS')!;
  assert.deepEqual(t.aggregate, [1, 2]);
  assert.equal(t.winner?.id, b.id);
});

test('empate no agregado decidido nos pênaltis', () => {
  const bracket = buildBracket([ko('QUARTER_FINALS', match(1, a, b, [1, 0])), ko('QUARTER_FINALS', match(2, b, a, [1, 0]), [3, 4])]);
  const [t] = bracket.get('QUARTER_FINALS')!;
  assert.deepEqual(t.aggregate, [1, 1]);
  assert.equal(t.winner?.id, a.id, 'a ganhou nos pênaltis jogando fora');
});

test('semifinais em aberto: final sai dos vencedores e as chances somam 1', () => {
  const matches = [
    ko('SEMI_FINALS', match(1, a, b, [3, 0])),
    ko('SEMI_FINALS', soon(match(2, b, a))),
    ko('SEMI_FINALS', match(1, c, d, [0, 0])),
    ko('SEMI_FINALS', soon(match(2, d, c))),
    ko('FINAL', soon(match(3, tbd(-1), tbd(-2)))),
  ];
  const out = simulateKnockout(buildBracket(matches), model, [1, 2, 3, 4], 4000, mulberry32(5));
  const total = [...out.champion.values()].reduce((s, p) => s + p, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.ok(out.champion.get(a.id)! > out.champion.get(b.id)!, 'quem venceu a ida por 3 x 0 é favorito');
  assert.ok(out.advance.get('SEMI_FINALS:0')! > 0.8);
  // Os dois finalistas somam 2 vagas na final
  const finalists = [...out.reach.get('FINAL')!.values()].reduce((s, p) => s + p, 0);
  assert.ok(Math.abs(finalists - 2) < 1e-9);
});

test('copa encerrada: campeão com 100%', () => {
  const out = simulateKnockout(buildBracket([ko('FINAL', match(1, a, b, [2, 1]))]), model, [1, 2], 100, mulberry32(1));
  assert.equal(out.champion.get(a.id), 1);
});

test('jogo adiado há muito tempo e nunca disputado não trava o confronto', () => {
  const old = { ...match(1, a, b), utcDate: '2020-01-01T00:00:00Z', status: 'SCHEDULED' as const };
  const bracket = buildBracket([ko('PLAY_OFFS', old), ko('PLAY_OFFS', match(2, b, a, [3, 1]))]);
  assert.equal(bracket.get('PLAY_OFFS')![0].winner?.id, b.id);
});

test('chances de cada final (campeão e vice) batem com as chances de título', () => {
  const matches = [
    ko('SEMI_FINALS', match(1, a, b, [3, 0])),
    ko('SEMI_FINALS', soon(match(2, b, a))),
    ko('SEMI_FINALS', match(1, c, d, [0, 0])),
    ko('SEMI_FINALS', soon(match(2, d, c))),
    ko('FINAL', soon(match(3, tbd(-1), tbd(-2)))),
  ];
  const out = simulateKnockout(buildBracket(matches), model, [1, 2, 3, 4], 4000, mulberry32(5));
  const total = [...out.podium.values()].reduce((s, p) => s + p, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  // Somando as finais em que `a` é campeão, dá a chance de título de `a`
  const aTitle = [...out.podium].filter(([k]) => k.startsWith(`${a.id}>`)).reduce((s, [, p]) => s + p, 0);
  assert.ok(Math.abs(aTitle - out.champion.get(a.id)!) < 1e-9);
  // a e b estão na mesma semifinal: nunca se enfrentam na final
  assert.ok(!out.podium.has(`${a.id}>${b.id}`));
});

test('fases de outra copa (Copa do Brasil) entram na ordem dada', () => {
  const stages: [string, string][] = [['LAST_16', 'Oitavas'], ['FINAL', 'Final']];
  const bracket = buildBracket([ko('FINAL', soon(match(2, a, c))), ko('LAST_16', match(1, a, b, [1, 0]))], stages);
  assert.deepEqual([...bracket.keys()], ['LAST_16', 'FINAL']);
  const out = simulateKnockout(bracket, model, [1, 2, 3], 1000, mulberry32(3));
  assert.ok(Math.abs((out.champion.get(a.id) ?? 0) + (out.champion.get(c.id) ?? 0) - 1) < 1e-9);
});
