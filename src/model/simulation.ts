// Monte Carlo: sorteia o placar de todos os jogos que faltam milhares de vezes
// e conta em que posição cada time terminou em cada uma dessas temporadas simuladas.
import { continentalSpots, type CupOutcomes, type SpotRules } from './cups.ts';
import { MAX_GOALS, remainingGoals, scoreMatrix, type FittedModel } from './prediction.ts';
import type { Rng } from './random.ts';
import { isFinished } from './standings.ts';
import type { Match, Team } from '../types.ts';

export interface TeamOutlook {
  teamId: number;
  /** positionProbs[i] = probabilidade de terminar em (i + 1)º */
  positionProbs: number[];
  title: number;
  libertadores: number;
  sulamericana: number;
  relegation: number;
  expectedPoints: number;
}

export interface SimulationOptions {
  runs: number;
  /** Vagas pela tabela (Libertadores e Sul-Americana) e quantos caem */
  zones: SpotRules & { relegation: number };
  rng: Rng;
  /** Sorteia as copas que dão vaga extra; sem isso, vale só a tabela */
  cups?: (rng: Rng) => CupOutcomes;
}

/** Até que posição vão as vagas, conforme as copas terminarem. */
export interface ZoneOutlook {
  /** libertadoresCutoff[i] = chance de a vaga pela tabela ir até o (i + 1)º */
  libertadoresCutoff: number[];
  sulamericanaCutoff: number[];
  /** Corte mais provável de cada zona (para colorir a tabela) */
  likely: { libertadores: number; sulamericana: number; relegation: number };
}

export interface SeasonOutlook {
  teams: TeamOutlook[];
  zones: ZoneOutlook;
}

const SIDE = MAX_GOALS + 1;

export function simulateSeason(teams: Team[], matches: Match[], model: FittedModel, opts: SimulationOptions): SeasonOutlook {
  const T = teams.length;
  const index = new Map(teams.map((t, i) => [t.id, i]));

  const basePts = new Int32Array(T);
  const baseWins = new Int32Array(T);
  const baseGd = new Int32Array(T);
  const baseGf = new Int32Array(T);

  // Para cada jogo pendente, a distribuição acumulada dos placares (para sortear)
  const pending: { h: number; a: number; cdf: Float64Array; hg: number; ag: number }[] = [];

  for (const m of matches) {
    const h = index.get(m.home.id)!;
    const a = index.get(m.away.id)!;
    if (isFinished(m)) {
      record(basePts, baseWins, baseGd, baseGf, h, a, m.homeGoals, m.awayGoals);
      continue;
    }
    const g = remainingGoals(model, m);
    const cdf = new Float64Array(SIDE * SIDE);
    let acc = 0;
    scoreMatrix(g.lh, g.la, g.rho).forEach((row, hg) =>
      row.forEach((p, ag) => {
        acc += p;
        cdf[hg * SIDE + ag] = acc;
      }),
    );
    pending.push({ h, a, cdf, hg: g.currentHome, ag: g.currentAway });
  }

  const pts = new Int32Array(T);
  const wins = new Int32Array(T);
  const gd = new Int32Array(T);
  const gf = new Int32Array(T);
  const tiebreak = new Float64Array(T);
  const order = teams.map((_, i) => i);
  const positionCounts = teams.map(() => new Float64Array(T));
  const pointsSum = new Float64Array(T);
  const libCount = new Float64Array(T);
  const sulCount = new Float64Array(T);
  const libCutoff = new Float64Array(T + 1);
  const sulCutoff = new Float64Array(T + 1);
  const ids = teams.map((t) => t.id);

  for (let run = 0; run < opts.runs; run++) {
    pts.set(basePts);
    wins.set(baseWins);
    gd.set(baseGd);
    gf.set(baseGf);

    for (const p of pending) {
      const u = opts.rng();
      let k = 0;
      while (k < p.cdf.length - 1 && p.cdf[k] < u) k++;
      record(pts, wins, gd, gf, p.h, p.a, p.hg + Math.floor(k / SIDE), p.ag + (k % SIDE));
    }

    // Empate em todos os critérios: decide no sorteio
    for (let i = 0; i < T; i++) tiebreak[i] = opts.rng();
    order.sort((x, y) => pts[y] - pts[x] || wins[y] - wins[x] || gd[y] - gd[x] || gf[y] - gf[x] || tiebreak[y] - tiebreak[x]);

    for (let pos = 0; pos < T; pos++) positionCounts[order[pos]][pos]++;
    for (let i = 0; i < T; i++) pointsSum[i] += pts[i];

    const spots = continentalSpots(
      order.map((i) => ids[i]),
      opts.zones,
      opts.cups?.(opts.rng),
    );
    for (let i = 0; i < T; i++) {
      if (spots.libertadores.has(ids[i])) libCount[i]++;
      if (spots.sulamericana.has(ids[i])) sulCount[i]++;
    }
    libCutoff[spots.libertadoresCutoff]++;
    sulCutoff[spots.sulamericanaCutoff]++;
  }

  const { relegation } = opts.zones;
  const outlook = teams.map((team, i) => {
    const probs = Array.from(positionCounts[i], (c) => c / opts.runs);
    const sum = (from: number, to: number) => probs.slice(from, to).reduce((acc, p) => acc + p, 0);
    return {
      teamId: team.id,
      positionProbs: probs,
      title: probs[0],
      libertadores: libCount[i] / opts.runs,
      sulamericana: sulCount[i] / opts.runs,
      relegation: sum(T - relegation, T),
      expectedPoints: pointsSum[i] / opts.runs,
    };
  });

  const toProbs = (counts: Float64Array) => Array.from(counts.subarray(1), (c) => c / opts.runs);
  const mode = (counts: Float64Array) => counts.indexOf(Math.max(...counts));
  return {
    teams: outlook,
    zones: {
      libertadoresCutoff: toProbs(libCutoff),
      sulamericanaCutoff: toProbs(sulCutoff),
      likely: { libertadores: mode(libCutoff), sulamericana: mode(sulCutoff), relegation },
    },
  };
}

function record(pts: Int32Array, wins: Int32Array, gd: Int32Array, gf: Int32Array, h: number, a: number, hg: number, ag: number) {
  gf[h] += hg;
  gf[a] += ag;
  gd[h] += hg - ag;
  gd[a] += ag - hg;
  if (hg > ag) {
    pts[h] += 3;
    wins[h]++;
  } else if (hg < ag) {
    pts[a] += 3;
    wins[a]++;
  } else {
    pts[h]++;
    pts[a]++;
  }
}
