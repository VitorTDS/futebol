// Mata-matas das copas e distribuição das vagas continentais pela tabela final.
import type { ContinentalCups, Cup, Leg, Side } from '../data/copas.ts';
import { MAX_GOALS, scoreMatrix, type FittedModel } from './prediction.ts';
import type { Rng } from './random.ts';

export interface CupResult {
  champion: Side;
  runnerUp: Side;
}

export interface CupOutcomes {
  copaDoBrasil: CupResult;
  libertadores: CupResult;
  sulamericana: CupResult;
}

const SIDE = MAX_GOALS + 1;

/**
 * Sorteia o resultado das três copas usando o mesmo modelo do Brasileirão.
 * Clube de fora da Série A joga como um time médio da liga.
 */
export function createCupSimulator(model: FittedModel, leagueTeamIds: number[], cups: ContinentalCups) {
  const league = new Set(leagueTeamIds);
  const known = (s: Side): s is number => typeof s === 'number' && league.has(s);
  const cdfs = new Map<string, Float64Array>();

  function expected(home: Side, away: Side): { home: number; away: number } {
    if (known(home) && known(away)) return model.expectedGoals(home, away);
    const others = leagueTeamIds.filter((id) => id !== home && id !== away);
    const avg = (pairs: { home: number; away: number }[]) => ({
      home: pairs.reduce((s, p) => s + p.home, 0) / pairs.length,
      away: pairs.reduce((s, p) => s + p.away, 0) / pairs.length,
    });
    if (known(home)) return avg(others.map((k) => model.expectedGoals(home, k)));
    if (known(away)) return avg(others.map((k) => model.expectedGoals(k, away)));
    return avg(others.flatMap((h) => others.filter((a) => a !== h).map((a) => model.expectedGoals(h, a))));
  }

  /** Distribuição acumulada dos placares, para sortear. */
  function cdf(home: Side, away: Side, neutral: boolean): Float64Array {
    const key = `${home}|${away}|${neutral}`;
    let c = cdfs.get(key);
    if (!c) {
      let lh: number;
      let la: number;
      if (neutral) {
        // Campo neutro: média das duas ordens de mando
        const x = expected(home, away);
        const y = expected(away, home);
        lh = (x.home + y.away) / 2;
        la = (x.away + y.home) / 2;
      } else {
        ({ home: lh, away: la } = expected(home, away));
      }
      c = new Float64Array(SIDE * SIDE);
      let acc = 0;
      scoreMatrix(lh, la, model.rho).forEach((row, hg) =>
        row.forEach((p, ag) => {
          acc += p;
          c![hg * SIDE + ag] = acc;
        }),
      );
      cdfs.set(key, c);
    }
    return c;
  }

  function play(leg: Leg, neutral: boolean, rng: Rng): [number, number] {
    if (leg.score) return leg.score;
    const c = cdf(leg.home, leg.away, neutral);
    const u = rng();
    let k = 0;
    while (k < c.length - 1 && c[k] < u) k++;
    return [Math.floor(k / SIDE), k % SIDE];
  }

  /** Soma dos gols nos jogos do confronto; empate vai para os pênaltis (50%). */
  function tie(legs: Leg[], neutral: boolean, rng: Rng): { winner: Side; loser: Side } {
    const a = legs[0].home;
    const b = legs[0].away;
    let ga = 0;
    let gb = 0;
    for (const leg of legs) {
      const [hg, ag] = play(leg, neutral, rng);
      if (leg.home === a) {
        ga += hg;
        gb += ag;
      } else {
        ga += ag;
        gb += hg;
      }
    }
    const aWins = ga > gb || (ga === gb && rng() < 0.5);
    return aWins ? { winner: a, loser: b } : { winner: b, loser: a };
  }

  function runCup(cup: Cup, rng: Rng): CupResult {
    if (cup.decided) return cup.decided;
    if (!cup.semifinals) throw new Error(`${cup.name}: falta "semifinals" ou "decided"`);
    const s1 = tie(cup.semifinals[0], false, rng).winner;
    const s2 = tie(cup.semifinals[1], false, rng).winner;
    const final = tie([{ home: s1, away: s2 }], cup.finalNeutral ?? true, rng);
    return { champion: final.winner, runnerUp: final.loser };
  }

  return (rng: Rng): CupOutcomes => ({
    copaDoBrasil: runCup(cups.copaDoBrasil, rng),
    libertadores: runCup(cups.libertadores, rng),
    sulamericana: runCup(cups.sulamericana, rng),
  });
}

export interface SpotRules {
  /** Vagas na Libertadores pela tabela do Brasileirão */
  libertadores: number;
  /** Vagas na Sul-Americana: os N mais bem colocados sem vaga na Libertadores */
  sulamericana: number;
}

export interface Spots {
  libertadores: Set<Side>;
  sulamericana: Set<number>;
  /** Pior posição (1 = primeiro) que ainda foi à Libertadores pela tabela; 0 se nenhuma */
  libertadoresCutoff: number;
  sulamericanaCutoff: number;
}

/**
 * Distribui as vagas a partir da classificação final (ids do 1º ao último).
 * Sem `cups`, vale só a tabela.
 */
export function continentalSpots(order: number[], rules: SpotRules, cups?: CupOutcomes): Spots {
  const extra: Side[] = [];
  if (cups) {
    extra.push(cups.copaDoBrasil.champion, cups.copaDoBrasil.runnerUp);
    // Título continental só dá vaga pelo Brasil se o campeão for brasileiro (da Série A)
    if (typeof cups.libertadores.champion === 'number') extra.push(cups.libertadores.champion);
    if (typeof cups.sulamericana.champion === 'number') extra.push(cups.sulamericana.champion);
  }
  const libertadores = new Set<Side>(extra);
  // Total de vagas = tabela + copas; vaga duplicada desce para o próximo da tabela
  let toFill = rules.libertadores + extra.length - libertadores.size;
  let libertadoresCutoff = 0;
  for (let pos = 0; pos < order.length && toFill > 0; pos++) {
    if (libertadores.has(order[pos])) continue;
    libertadores.add(order[pos]);
    libertadoresCutoff = pos + 1;
    toFill--;
  }

  const sulamericana = new Set<number>();
  let sulamericanaCutoff = 0;
  for (let pos = 0; pos < order.length && sulamericana.size < rules.sulamericana; pos++) {
    if (libertadores.has(order[pos])) continue;
    sulamericana.add(order[pos]);
    sulamericanaCutoff = pos + 1;
  }
  return { libertadores, sulamericana, libertadoresCutoff, sulamericanaCutoff };
}
