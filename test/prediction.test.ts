import assert from 'node:assert/strict';
import { test } from 'node:test';
import { predict, scoreMatrix } from '../src/model/prediction.ts';
import { mulberry32 } from '../src/model/random.ts';
import { simulateSeason } from '../src/model/simulation.ts';
import type { FittedModel } from '../src/model/prediction.ts';
import { match, team } from './helpers.ts';

const close = (x: number, y: number, eps = 1e-9) => assert.ok(Math.abs(x - y) < eps, `${x} ≠ ${y}`);

test('a matriz de placares soma 1', () => {
  for (const rho of [0, -0.1]) {
    const total = scoreMatrix(1.4, 1.1, rho).flat().reduce((s, p) => s + p, 0);
    close(total, 1);
  }
});

test('vitória, empate e derrota somam 1 e o favorito é quem tem mais gols esperados', () => {
  const p = predict(2.0, 0.6);
  close(p.pHome + p.pDraw + p.pAway, 1);
  assert.ok(p.pHome > p.pAway);
});

test('times iguais têm chances simétricas', () => {
  const p = predict(1.2, 1.2);
  close(p.pHome, p.pAway, 1e-12);
});

test('jogo ao vivo parte do placar atual', () => {
  // Sem gols esperados no resto do jogo, o placar atual é o final
  const p = predict(0, 0, 0, 2, 1);
  close(p.pHome, 1);
  assert.deepEqual(p.likelyScore, [2, 1]);
});

/** Modelo fixo: o time com id menor marca mais. */
const model: FittedModel = {
  kind: 'poisson',
  rho: 0,
  expectedGoals: (h, a) => ({ home: h < a ? 2.5 : 0.5, away: a < h ? 2.5 : 0.5 }),
};

test('simulação: probabilidades de cada time somam 1 e cada posição tem um time', () => {
  const teams = [team(1), team(2), team(3), team(4)];
  const matches = [];
  for (const h of teams) for (const a of teams) if (h !== a) matches.push(match(1, h, a));
  const out = simulateSeason(teams, matches, model, {
    runs: 2000,
    zones: { libertadores: 1, sulamericana: 1, relegation: 1 },
    rng: mulberry32(42),
  }).teams;
  for (const o of out) close(o.positionProbs.reduce((s, p) => s + p, 0), 1, 1e-9);
  for (let pos = 0; pos < teams.length; pos++) close(out.reduce((s, o) => s + o.positionProbs[pos], 0), 1, 1e-9);
  assert.ok(out[0].title > 0.5, 'o time mais forte deve ser o favorito');
  assert.ok(out[3].relegation > 0.5, 'o mais fraco deve ser o mais ameaçado');
});

test('simulação respeita os jogos já encerrados', () => {
  const [a, b] = [team(1), team(2)];
  // Só um jogo, já encerrado: não há o que sortear
  const out = simulateSeason([a, b], [match(1, b, a, [3, 0])], model, {
    runs: 100,
    zones: { libertadores: 1, sulamericana: 1, relegation: 1 },
    rng: mulberry32(1),
  }).teams;
  assert.equal(out.find((o) => o.teamId === b.id)!.title, 1);
});
