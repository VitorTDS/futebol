// Modelo de Dixon-Coles (1997). Em relação ao Poisson simples, ele:
//  1. estima ataque, defesa e fator casa por máxima verossimilhança, levando em
//     conta a força dos adversários que cada time enfrentou;
//  2. dá mais peso aos jogos recentes (decaimento no tempo);
//  3. corrige a frequência dos placares baixos (0×0, 1×0, 0×1, 1×1) com o parâmetro rho.
//
// Gols esperados: mandante = casa × ataque(mandante) × defesa(visitante)
//                 visitante =        ataque(visitante) × defesa(mandante)
//
// O ajuste é feito em duas etapas (forças primeiro, rho depois), uma aproximação
// muito usada do ajuste conjunto do artigo original: o rho quase não altera as forças.
import type { FittedModel } from './prediction.ts';
import { tau } from './prediction.ts';
import { isFinished } from './standings.ts';
import type { Match, Team } from '../types.ts';

/** Gols "fictícios" na média, somados a cada time: segura exageros no começo do campeonato. */
const PRIOR_GOALS = 4;
const MAX_ITERATIONS = 100;
/** Para quando nenhum parâmetro muda mais que isso numa iteração */
const TOLERANCE = 1e-5;
const RHO_MIN = -0.25;
const RHO_MAX = 0.25;
const DAY_MS = 86_400_000;

export interface DixonColesOptions {
  /** Data "de hoje" para o modelo: jogos mais antigos que ela pesam menos */
  asOf: string;
  /** Decaimento por dia (0 = todos os jogos pesam igual) */
  timeDecay: number;
  /**
   * Ponto de partida de times específicos, relativo à média (1 = média da liga).
   * Usado para quem subiu da Série B: sem jogos na elite, começa perto do nível
   * de quem caiu, e não da média. Sem isso, todo time parte da média.
   */
  priors?: Map<number, { attack: number; defense: number }>;
}

export function fitDixonColes(teams: Team[], matches: Match[], opts: DixonColesOptions): FittedModel {
  const asOf = Date.parse(opts.asOf);
  const games = matches
    .filter(isFinished)
    .map((m) => ({
      h: m.home.id,
      a: m.away.id,
      hg: m.homeGoals,
      ag: m.awayGoals,
      w: Math.exp(-opts.timeDecay * Math.max(0, (asOf - Date.parse(m.utcDate)) / DAY_MS)),
    }));

  const attack = new Map(teams.map((t) => [t.id, 1]));
  const defense = new Map(teams.map((t) => [t.id, 1.2]));
  let home = 1.2;

  if (games.length) {
    for (let it = 0; it < MAX_ITERATIONS; it++) {
      const previous = [...attack.values(), ...defense.values(), home];
      // Cada passo resolve exatamente um grupo de parâmetros com os outros fixos
      // (subida por coordenadas na verossimilhança de Poisson ponderada).
      const scored = new Map<number, number>();
      const scoredExp = new Map<number, number>();
      for (const g of games) {
        add(scored, g.h, g.w * g.hg);
        add(scoredExp, g.h, g.w * home * defense.get(g.a)!);
        add(scored, g.a, g.w * g.ag);
        add(scoredExp, g.a, g.w * defense.get(g.h)!);
      }
      for (const t of teams) {
        const target = opts.priors?.get(t.id)?.attack ?? 1;
        attack.set(t.id, ((scored.get(t.id) ?? 0) + PRIOR_GOALS * target) / ((scoredExp.get(t.id) ?? 0) + PRIOR_GOALS));
      }

      const meanDefense = mean(defense);
      const conceded = new Map<number, number>();
      const concededExp = new Map<number, number>();
      for (const g of games) {
        add(conceded, g.a, g.w * g.hg);
        add(concededExp, g.a, g.w * home * attack.get(g.h)!);
        add(conceded, g.h, g.w * g.ag);
        add(concededExp, g.h, g.w * attack.get(g.a)!);
      }
      for (const t of teams) {
        const target = meanDefense * (opts.priors?.get(t.id)?.defense ?? 1);
        defense.set(t.id, ((conceded.get(t.id) ?? 0) + PRIOR_GOALS) / ((concededExp.get(t.id) ?? 0) + PRIOR_GOALS / target));
      }

      let homeGoals = 0;
      let homeExp = 0;
      for (const g of games) {
        homeGoals += g.w * g.hg;
        homeExp += g.w * attack.get(g.h)! * defense.get(g.a)!;
      }
      home = homeGoals / homeExp;

      // Ataque com média 1; a defesa absorve a escala (os produtos não mudam)
      const scale = mean(attack);
      for (const t of teams) {
        attack.set(t.id, attack.get(t.id)! / scale);
        defense.set(t.id, defense.get(t.id)! * scale);
      }

      const current = [...attack.values(), ...defense.values(), home];
      if (current.every((v, i) => Math.abs(v - previous[i]) < TOLERANCE)) break;
    }
  }

  const expectedGoals = (homeId: number, awayId: number) => ({
    home: home * (attack.get(homeId) ?? 1) * (defense.get(awayId) ?? 1),
    away: (attack.get(awayId) ?? 1) * (defense.get(homeId) ?? 1),
  });

  // rho: maximiza a verossimilhança só dos placares que a correção afeta
  const lowScores = games
    .filter((g) => g.hg <= 1 && g.ag <= 1)
    .map((g) => ({ ...g, xg: expectedGoals(g.h, g.a) }));
  const rho = lowScores.length
    ? goldenSectionMax(
        (r) => lowScores.reduce((sum, g) => sum + g.w * Math.log(Math.max(1e-9, tau(g.hg, g.ag, g.xg.home, g.xg.away, r))), 0),
        RHO_MIN,
        RHO_MAX,
      )
    : 0;

  return { kind: 'dixon-coles', rho, expectedGoals };
}

function add(map: Map<number, number>, id: number, v: number) {
  map.set(id, (map.get(id) ?? 0) + v);
}

function mean(map: Map<number, number>): number {
  let sum = 0;
  for (const v of map.values()) sum += v;
  return sum / map.size;
}

/** Máximo de uma função côncava num intervalo. */
function goldenSectionMax(f: (x: number) => number, lo: number, hi: number, tol = 1e-4): number {
  const g = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = f(c);
  let fd = f(d);
  while (b - a > tol) {
    if (fc > fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - g * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + g * (b - a);
      fd = f(d);
    }
  }
  return (a + b) / 2;
}
