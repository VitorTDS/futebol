// Calibração do TIME_DECAY do Dixon-Coles: roda o histórico de acertos com
// vários valores de decaimento e compara cada um com o valor padrão, jogo a jogo.
// Só troca o padrão quando a melhora é consistente: com algumas centenas de
// jogos, diferenças pequenas na nota Brier podem ser só sorte.
import { backtest, type BacktestResult } from './backtest.ts';
import type { Background } from './models.ts';
import type { Match, Team } from '../types.ts';

/** Valores testados (por dia). 0 = todos os jogos pesam igual. */
export const DECAY_GRID = [0, 0.001, 0.002, 0.003, 0.005, 0.0075, 0.01, 0.015, 0.02, 0.03, 0.05];

/** Com poucos jogos a diferença entre os valores é puro ruído: não calibra. */
export const MIN_MATCHES = 100;

/**
 * Quão clara precisa ser a melhora sobre o padrão (estatística z do teste
 * pareado). 1,64 ≈ 95% de confiança de que a melhora não é sorte.
 */
const MIN_Z = 1.64;

export interface DecayPoint {
  decay: number;
  /** Em quantos dias o peso de um jogo cai pela metade (null = nunca) */
  halfLifeDays: number | null;
  brier: number;
  accuracy: number;
  /** Comparação jogo a jogo com o padrão: positivo = melhor que o padrão */
  zVsDefault: number;
  /** Melhora sobre o padrão grande o bastante para não ser sorte */
  significant: boolean;
}

export interface Calibration {
  best: number;
  defaultDecay: number;
  /** better = achou valor claramente melhor; kept-default = nenhum foi claramente melhor */
  outcome: 'better' | 'kept-default';
  /** O melhor valor ficou na ponta da lista testada (o ideal pode estar além) */
  atEdge: boolean;
  points: DecayPoint[];
  /** Histórico completo do valor escolhido (reaproveitado na aba Acertos) */
  bestResult: BacktestResult;
}

export const halfLife = (decay: number) => (decay > 0 ? Math.round(Math.log(2) / decay) : null);

/** Estatística z da diferença média (pareada) entre as notas Brier jogo a jogo. */
function pairedZ(base: BacktestResult, candidate: BacktestResult): number {
  const diffs = base.entries.map((e, i) => e.brier - candidate.entries[i].brier);
  const n = diffs.length;
  if (n < 2) return 0;
  const mean = diffs.reduce((s, d) => s + d, 0) / n;
  const variance = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (n - 1);
  return variance > 0 ? mean / Math.sqrt(variance / n) : 0;
}

/**
 * Assíncrona de propósito: devolve o controle ao servidor entre um valor e
 * outro, para as outras requisições não ficarem esperando.
 */
export async function calibrateTimeDecay(
  teams: Team[],
  matches: Match[],
  defaultDecay: number,
  background?: Background | null,
): Promise<Calibration> {
  const grid = DECAY_GRID.includes(defaultDecay) ? DECAY_GRID : [...DECAY_GRID, defaultDecay].sort((a, b) => a - b);
  const results: { decay: number; result: BacktestResult }[] = [];
  for (const decay of grid) {
    await new Promise((r) => setImmediate(r));
    results.push({ decay, result: backtest('dixon-coles', teams, matches, decay, background) });
  }

  const base = results.find((r) => r.decay === defaultDecay)!.result;
  const points: DecayPoint[] = results.map(({ decay, result }) => {
    const z = decay === defaultDecay ? 0 : pairedZ(base, result);
    return {
      decay,
      halfLifeDays: halfLife(decay),
      brier: result.summary.brier,
      accuracy: result.summary.accuracy,
      zVsDefault: z,
      significant: z >= MIN_Z,
    };
  });

  const candidates = points.filter((p) => p.significant);
  const chosen = candidates.length ? candidates.reduce((a, b) => (b.brier < a.brier ? b : a)) : points.find((p) => p.decay === defaultDecay)!;
  const overallBest = points.reduce((a, b) => (b.brier < a.brier ? b : a));

  return {
    best: chosen.decay,
    defaultDecay,
    outcome: candidates.length ? 'better' : 'kept-default',
    atEdge: overallBest.decay === grid[0] || overallBest.decay === grid.at(-1),
    points,
    bestResult: results.find((r) => r.decay === chosen.decay)!.result,
  };
}
