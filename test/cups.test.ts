import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ContinentalCups } from '../src/data/copas.ts';
import { continentalSpots, createCupSimulator, type CupOutcomes } from '../src/model/cups.ts';
import type { FittedModel } from '../src/model/prediction.ts';
import { mulberry32 } from '../src/model/random.ts';

// Tabela final com ids 1 a 20, na ordem
const order = Array.from({ length: 20 }, (_, i) => i + 1);
const rules = { libertadores: 5, sulamericana: 6 };

const outcomes = (cdb: [number | string, number | string], lib: number | string, sula: number | string): CupOutcomes => ({
  copaDoBrasil: { champion: cdb[0], runnerUp: cdb[1] },
  libertadores: { champion: lib, runnerUp: 'x' },
  sulamericana: { champion: sula, runnerUp: 'y' },
});

test('sem copas: G5 na Libertadores e os 6 seguintes na Sul-Americana', () => {
  const s = continentalSpots(order, rules);
  assert.deepEqual([...s.libertadores], [1, 2, 3, 4, 5]);
  assert.deepEqual([...s.sulamericana], [6, 7, 8, 9, 10, 11]);
  assert.equal(s.libertadoresCutoff, 5);
  assert.equal(s.sulamericanaCutoff, 11);
});

test('campeões que já estão no G5 liberam vagas para baixo (até G9)', () => {
  // Copa do Brasil: 1º e 2º; Libertadores: 3º; Sul-Americana: 4º
  const s = continentalSpots(order, rules, outcomes([1, 2], 3, 4));
  assert.equal(s.libertadores.size, 9);
  assert.equal(s.libertadoresCutoff, 9);
  assert.equal(s.sulamericanaCutoff, 15);
});

test('campeões de fora do G5 entram e a tabela segue no G5', () => {
  const s = continentalSpots(order, rules, outcomes([12, 15], 18, 7));
  assert.equal(s.libertadoresCutoff, 5);
  for (const id of [12, 15, 18, 7]) assert.ok(s.libertadores.has(id));
  // Sul-Americana pula quem já foi para a Libertadores (o 7º)
  assert.deepEqual([...s.sulamericana], [6, 8, 9, 10, 11, 13]);
});

test('campeão estrangeiro não dá vaga pelo Brasil', () => {
  const s = continentalSpots(order, rules, outcomes([1, 2], 'Estudiantes', 'Boca Juniors'));
  // 5 + 2 vagas; o 1º e o 2º já estavam no G5, então vai até o 7º
  assert.equal(s.libertadores.size, 7);
  assert.equal(s.libertadoresCutoff, 7);
});

test('mesmo clube campeão de duas copas: a vaga extra desce', () => {
  // 1º ganha Copa do Brasil e Libertadores; vice da Copa é o 10º
  const s = continentalSpots(order, rules, outcomes([1, 10], 1, 'Boca Juniors'));
  // 5 + 3 vagas, clubes distintos das copas: 1 e 10 → tabela preenche 6 sem eles: 2..7
  assert.equal(s.libertadores.size, 8);
  assert.equal(s.libertadoresCutoff, 7);
});

test('simulador das copas respeita confronto já decidido e placar de ida', () => {
  const model: FittedModel = { kind: 'poisson', rho: 0, expectedGoals: () => ({ home: 1.3, away: 1.1 }) };
  const cups: ContinentalCups = {
    copaDoBrasil: { name: 'CdB', decided: { champion: 1, runnerUp: 2 } },
    libertadores: {
      name: 'Liberta',
      // Ida 10 x 0: o time 1 não tem como ser eliminado
      semifinals: [[{ home: 1, away: 2, score: [10, 0] }, { home: 2, away: 1 }], [{ home: 3, away: 'Fora', score: [0, 10] }, { home: 'Fora', away: 3 }]],
    },
    sulamericana: { name: 'Sula', decided: { champion: 'Fora', runnerUp: 4 } },
  };
  const run = createCupSimulator(model, [1, 2, 3, 4], cups);
  const rng = mulberry32(7);
  for (let i = 0; i < 200; i++) {
    const r = run(rng);
    assert.deepEqual(r.copaDoBrasil, { champion: 1, runnerUp: 2 });
    assert.ok([1, 'Fora'].includes(r.libertadores.champion));
    assert.ok([1, 'Fora'].includes(r.libertadores.runnerUp));
  }
});
