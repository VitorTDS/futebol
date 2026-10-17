// Histórico de acertos: para cada jogo já encerrado, refaz a previsão usando
// SÓ os jogos que aconteceram antes dele (como se o modelo tivesse rodado na
// véspera) e compara com o resultado real.
import { fitModel, type Background } from './models.ts';
import { predictMatch, type FittedModel, type ModelKind, type Prediction } from './prediction.ts';
import { isFinished } from './standings.ts';
import type { Match, Team } from '../types.ts';

export type Outcome = 'H' | 'D' | 'A';

export interface BacktestEntry {
  match: Match;
  prediction: Prediction;
  predicted: Outcome;
  actual: Outcome;
  hit: boolean;
  exactHit: boolean;
  /** Brier score do jogo: 0 = previsão perfeita, 2 = o pior possível */
  brier: number;
}

export interface MatchdayAccuracy {
  matchday: number;
  total: number;
  hits: number;
  accuracy: number;
}

export interface CalibrationBucket {
  from: number;
  to: number;
  total: number;
  /** Probabilidade média que o modelo deu */
  predicted: number;
  /** Com que frequência aconteceu de fato */
  observed: number;
}

export interface BacktestSummary {
  total: number;
  hits: number;
  accuracy: number;
  exactHits: number;
  exactAccuracy: number;
  brier: number;
  /** Comparações com "palpites ingênuos" */
  baseline: {
    /** Acerto de quem sempre aposta no mandante */
    homeAccuracy: number;
    /** Brier de quem sempre usa a frequência histórica de vitória/empate/derrota */
    frequencyBrier: number;
  };
  byMatchday: MatchdayAccuracy[];
  calibration: CalibrationBucket[];
}

const outcomeOf = (h: number, a: number): Outcome => (h > a ? 'H' : h === a ? 'D' : 'A');

function brierScore(p: [number, number, number], actual: Outcome): number {
  const real = [actual === 'H' ? 1 : 0, actual === 'D' ? 1 : 0, actual === 'A' ? 1 : 0];
  return p.reduce((sum, pi, i) => sum + (pi - real[i]) ** 2, 0);
}

export interface BacktestResult {
  summary: BacktestSummary;
  entries: BacktestEntry[];
}

export function backtest(
  kind: ModelKind,
  teams: Team[],
  matches: Match[],
  timeDecay: number,
  background?: Background | null,
): BacktestResult {
  const finished = matches.filter(isFinished).sort((a, b) => a.utcDate.localeCompare(b.utcDate));
  // Jogos no mesmo horário usam o mesmo modelo: ajusta uma vez por horário
  const modelsByTime = new Map<string, FittedModel>();

  const entries: BacktestEntry[] = [];
  let homeHits = 0;
  let frequencyBrierSum = 0;
  const counts = { H: 0, D: 0, A: 0 };

  for (let i = 0; i < finished.length; i++) {
    const m = finished[i];
    let model = modelsByTime.get(m.utcDate);
    if (!model) {
      const before = finished.filter((x) => x.utcDate < m.utcDate);
      model = fitModel(kind, teams, before, m.utcDate, timeDecay, background);
      modelsByTime.set(m.utcDate, model);
    }
    // Previsão "pré-jogo": trata o jogo como ainda não iniciado
    const prediction = predictMatch(model, { ...m, status: 'SCHEDULED', homeGoals: null, awayGoals: null });

    const probs: [number, number, number] = [prediction.pHome, prediction.pDraw, prediction.pAway];
    const predicted: Outcome = (['H', 'D', 'A'] as const)[probs.indexOf(Math.max(...probs))];
    const actual = outcomeOf(m.homeGoals, m.awayGoals);

    entries.push({
      match: m,
      prediction,
      predicted,
      actual,
      hit: predicted === actual,
      exactHit: prediction.likelyScore[0] === m.homeGoals && prediction.likelyScore[1] === m.awayGoals,
      brier: brierScore(probs, actual),
    });

    // Palpites ingênuos (também só com o que se sabia antes do jogo)
    if (actual === 'H') homeHits++;
    const n = counts.H + counts.D + counts.A;
    const freq: [number, number, number] = n
      ? [counts.H / n, counts.D / n, counts.A / n]
      : [0.47, 0.27, 0.26];
    frequencyBrierSum += brierScore(freq, actual);
    counts[actual]++;
  }

  const total = entries.length;
  const hits = entries.filter((e) => e.hit).length;
  const exactHits = entries.filter((e) => e.exactHit).length;
  const ratio = (a: number, b: number) => (b ? a / b : 0);

  return {
    entries,
    summary: {
      total,
      hits,
      accuracy: ratio(hits, total),
      exactHits,
      exactAccuracy: ratio(exactHits, total),
      brier: ratio(entries.reduce((s, e) => s + e.brier, 0), total),
      baseline: {
        homeAccuracy: ratio(homeHits, total),
        frequencyBrier: ratio(frequencyBrierSum, total),
      },
      byMatchday: byMatchday(entries),
      calibration: calibration(entries),
    },
  };
}

function byMatchday(entries: BacktestEntry[]): MatchdayAccuracy[] {
  const groups = Map.groupBy(entries, (e) => e.match.matchday);
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([matchday, list]) => {
      const hits = list.filter((e) => e.hit).length;
      return { matchday, total: list.length, hits, accuracy: hits / list.length };
    });
}

/**
 * Calibração: junta todas as probabilidades dadas (vitória, empate e derrota de
 * cada jogo) em faixas de 10% e mede quantas vezes aquilo aconteceu.
 * Um modelo bem calibrado acerta ~60% das vezes quando diz 60%.
 */
function calibration(entries: BacktestEntry[]): CalibrationBucket[] {
  const buckets = Array.from({ length: 10 }, (_, i) => ({ from: i / 10, to: (i + 1) / 10, total: 0, pSum: 0, happened: 0 }));

  for (const e of entries) {
    const pairs: [number, Outcome][] = [
      [e.prediction.pHome, 'H'],
      [e.prediction.pDraw, 'D'],
      [e.prediction.pAway, 'A'],
    ];
    for (const [p, outcome] of pairs) {
      const b = buckets[Math.min(9, Math.floor(p * 10))];
      b.total++;
      b.pSum += p;
      if (outcome === e.actual) b.happened++;
    }
  }

  return buckets
    .filter((b) => b.total > 0)
    .map((b) => ({ from: b.from, to: b.to, total: b.total, predicted: b.pSum / b.total, observed: b.happened / b.total }));
}
