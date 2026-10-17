import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createEspnCupProvider, SULA_STAGES } from '../src/data/espnCup.ts';
import type { Team } from '../src/types.ts';

// Respostas de verdade da ESPN (Sul-Americana 2026), enxutas: um jogo de grupo,
// uma disputa de pênaltis, um jogo marcado e a final ainda sem os times
const scoreboard = JSON.parse(readFileSync(new URL('./fixtures/espn-sula-2026.json', import.meta.url), 'utf8'));
const standings = JSON.parse(readFileSync(new URL('./fixtures/espn-sula-grupos-2026.json', import.meta.url), 'utf8'));

// A ESPN fica de fora: cada endereço devolve o arquivo correspondente
globalThis.fetch = (async (url: string | URL) => {
  const u = String(url);
  const body = u.includes('/standings') ? standings : u.includes('dates=2026') ? scoreboard : { events: [] };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

const VASCO = 1780; // id da football-data (Série A)
const vascoDoBrasileirao: Team = { id: VASCO, name: 'CR Vasco da Gama', shortName: 'Vasco', tla: 'VAS', crest: 'escudo-fd.png' };
const provider = createEspnCupProvider({
  league: 'conmebol.sudamericana',
  year: 2026,
  stages: SULA_STAGES,
  hasGroups: true,
  leagueTeams: async () => [vascoDoBrasileirao],
});

test('jogos da ESPN viram jogos do painel: fase, grupo, placar e status', async () => {
  const matches = await provider.getMatches();
  assert.equal(matches.length, 4);
  const [grupo, penaltis, semi, final] = matches;

  // Clube da Série A usa o mesmo time do Brasileirão (id, nome e escudo)
  assert.equal(grupo.home.id, VASCO);
  assert.equal(grupo.home.shortName, 'Vasco');
  assert.equal(grupo.stage, 'GROUP_STAGE');
  assert.equal(grupo.group, 'GROUP_G');
  assert.equal(grupo.status, 'FINISHED');
  assert.deepEqual([grupo.homeGoals, grupo.awayGoals], [1, 2]);
  // Estrangeiro ganha id próprio, que não colide com a football-data
  assert.ok(grupo.away.id > 9_000_000);
  assert.equal(grupo.away.name, 'Audax Italiano');

  // Placar sem os pênaltis; pênaltis à parte
  assert.equal(penaltis.stage, 'ROUND_1');
  assert.deepEqual([penaltis.homeGoals, penaltis.awayGoals], [0, 0]);
  assert.deepEqual(penaltis.penalties, [3, 2]);

  assert.equal(semi.stage, 'SEMI_FINALS');
  assert.equal(semi.status, 'SCHEDULED');
  assert.equal(semi.homeGoals, null);

  // Final ainda sem os times
  assert.equal(final.stage, 'FINAL');
  assert.ok(final.home.tbd && final.away.tbd);
});

test('artilharia soma os gols de cada jogo, sem os pênaltis da disputa', async () => {
  const scorers = (await provider.getScorers())!;
  const names = scorers.map((s) => s.player);
  // 3 gols no jogo de grupo; os 5 da disputa de pênaltis não contam
  assert.equal(scorers.reduce((s, x) => s + x.goals, 0), 3);
  assert.ok(names.includes('Brenner') && names.includes('Franco Troyansky'));
  assert.ok(!names.includes('Jonatan Cristaldo'));
  const troyansky = scorers.find((s) => s.player === 'Franco Troyansky')!;
  assert.equal(troyansky.penalties, 1);
  assert.equal(scorers.find((s) => s.player === 'Brenner')!.team.id, VASCO);
});
