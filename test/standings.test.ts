import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeStandings, currentMatchday } from '../src/model/standings.ts';
import { match, team } from './helpers.ts';

const a = team(1);
const b = team(2);
const c = team(3);
const d = team(4);

test('pontos, saldo e forma', () => {
  const rows = computeStandings([a, b], [match(1, a, b, [2, 0]), match(2, b, a, [1, 1])]);
  assert.equal(rows[0].team.id, a.id);
  assert.deepEqual([rows[0].points, rows[0].won, rows[0].drawn, rows[0].goalDiff], [4, 1, 1, 2]);
  assert.deepEqual(rows[0].form, ['V', 'E']);
  assert.deepEqual([rows[1].points, rows[1].lost, rows[1].goalDiff], [1, 1, -2]);
});

test('desempate: vitórias antes do saldo de gols', () => {
  // a: 1 vitória e 1 derrota (3 pts, saldo 0); b: 3 empates (3 pts, saldo 0) — a fica na frente pelas vitórias
  const matches = [match(1, a, c, [1, 0]), match(2, a, d, [0, 1]), match(1, b, d, [0, 0]), match(2, b, c, [0, 0]), match(3, b, c, [1, 1])];
  const rows = computeStandings([a, b, c, d], matches);
  const pos = (t: typeof a) => rows.findIndex((r) => r.team.id === t.id);
  assert.ok(pos(a) < pos(b));
});

test('jogos sem placar não contam', () => {
  const rows = computeStandings([a, b], [match(1, a, b)]);
  assert.equal(rows[0].played, 0);
});

test('rodada atual ignora um jogo adiado solto numa rodada antiga', () => {
  const [e, f] = [team(5), team(6)];
  const matches = [
    match(1, a, b, [1, 0]),
    match(1, c, d, [0, 2]),
    match(1, e, f), // adiado
    match(2, a, c, [0, 0]),
    match(2, b, e, [2, 1]),
    match(2, d, f, [1, 1]),
    match(3, a, d),
    match(3, b, f),
    match(3, c, e),
  ];
  assert.equal(currentMatchday(matches), 3);
});

test('rodada atual: primeira com metade ou mais dos jogos pendentes', () => {
  const matches = [match(1, a, b, [1, 0]), match(1, c, d, [0, 0]), match(2, a, c, [2, 2]), match(2, b, d)];
  assert.equal(currentMatchday(matches), 2);
});

test('rodada atual com o campeonato encerrado é a última', () => {
  assert.equal(currentMatchday([match(1, a, b, [1, 0]), match(2, b, a, [0, 0])]), 2);
});
