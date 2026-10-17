import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalizeSummary } from '../src/data/espn.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

// Flamengo 1 x 0 Fluminense (rodada 30), já encerrado
const flaFlu = normalizeSummary('401841263', fixture('espn-fla-flu.json'), '819');

test('jogo encerrado: estatísticas do jogo em português, do lado certo', () => {
  const posse = flaFlu.stats.find((s) => s.key === 'possessionPct')!;
  assert.equal(posse.label, 'Posse de bola');
  assert.deepEqual(posse.display, ['44%', '57%']);
  const passes = flaFlu.stats.find((s) => s.key === 'totalPasses')!;
  assert.deepEqual([passes.home, passes.away], [426, 558]);
  // Precisão calculada a partir dos passes certos, não o 0.9 arredondado
  assert.deepEqual(flaFlu.stats.find((s) => s.key === 'passPct')!.display, ['89%', '89%']);
});

test('jogo encerrado: gol com autor e assistência, cartões e substituições', () => {
  const gol = flaFlu.events.find((e) => e.type === 'goal')!;
  assert.deepEqual([gol.minute, gol.side, gol.player, gol.other], ["65'", 'home', 'Jorge Carrascal', 'Lucas Paquetá']);
  assert.ok(flaFlu.events.some((e) => e.type === 'yellow' && e.side === 'away'));
  const sub = flaFlu.events.find((e) => e.type === 'sub')!;
  assert.equal(typeof sub.other, 'string');
});

test('escalações com formação, 11 titulares e reservas', () => {
  assert.equal(flaFlu.lineups!.home.formation, '4-2-3-1');
  assert.equal(flaFlu.lineups!.home.starters.length, 11);
  assert.equal(flaFlu.lineups!.away.starters.length, 11);
  assert.ok(flaFlu.lineups!.home.bench.length > 0);
});

// Botafogo x Chapecoense, ainda vai acontecer
const botCha = normalizeSummary('401841268', fixture('espn-bot-cha.json'), '6086');

test('jogo futuro: sem estatísticas nem escalação, mas com confronto, destaques e cotações', () => {
  assert.equal(botCha.stats.length, 0);
  assert.equal(botCha.lineups, null);
  assert.ok(botCha.h2h.length >= 3);
  assert.ok(botCha.h2h[0].date >= botCha.h2h.at(-1)!.date, 'mais recente primeiro');
  assert.equal(botCha.leaders.home.find((l) => l.label === 'Artilheiro')!.name, 'Danilo Santos');
  const o = botCha.odds!;
  assert.ok(Math.abs(o.home + o.draw + o.away - 1) < 1e-9);
  assert.ok(o.home > o.away, 'Botafogo é o favorito nas casas');
});

test('confronto direto diz qual dos dois times venceu cada jogo', () => {
  // 14/05/2026: Chapecoense 2 x 0 Botafogo → venceu o visitante deste jogo (Chapecoense)
  const g = botCha.h2h.find((x) => x.date.startsWith('2026-05-14'))!;
  assert.equal(g.winner, 'away');
  const draw = botCha.h2h.find((x) => x.homeScore === x.awayScore);
  if (draw) assert.equal(draw.winner, null);
});
