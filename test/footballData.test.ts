import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixTeam } from '../src/data/footballData.ts';

test('Coritiba e Corinthians ficam com siglas diferentes', () => {
  const coritiba = fixTeam({ id: 4241, name: 'Coritiba FBC', shortName: 'Coritiba', tla: 'COR' });
  const corinthians = fixTeam({ id: 1779, name: 'SC Corinthians Paulista', shortName: 'Corinthians', tla: 'COR' });
  assert.notEqual(coritiba.tla, corinthians.tla);
});

test('nomes curtos estranhos da API são corrigidos', () => {
  assert.equal(fixTeam({ id: 1766, name: 'CA Mineiro', shortName: 'Mineiro', tla: 'CAM' }).shortName, 'Atlético-MG');
  assert.equal(fixTeam({ id: 1768, name: 'CA Paranaense', shortName: 'Paranaense', tla: 'CAP' }).shortName, 'Athletico-PR');
});

test('time sem correção fica como veio', () => {
  const t = { id: 1783, name: 'CR Flamengo', shortName: 'Flamengo', tla: 'FLA' };
  assert.deepEqual(fixTeam(t), t);
});
