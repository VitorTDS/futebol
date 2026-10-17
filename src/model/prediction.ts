// Parte comum aos modelos: a partir dos gols esperados de cada time, monta a
// matriz com a probabilidade de cada placar e tira dela as chances do jogo.
import type { Match } from '../types.ts';

export const MAX_GOALS = 10;

export type ModelKind = 'poisson' | 'dixon-coles';

export const MODEL_LABELS: Record<ModelKind, string> = {
  poisson: 'Poisson simples',
  'dixon-coles': 'Dixon-Coles',
};

export interface FittedModel {
  kind: ModelKind;
  expectedGoals(homeId: number, awayId: number): { home: number; away: number };
  /** Correção de Dixon-Coles para placares baixos (0 = Poisson puro) */
  rho: number;
}

export interface Prediction {
  expectedHome: number;
  expectedAway: number;
  pHome: number;
  pDraw: number;
  pAway: number;
  likelyScore: [number, number];
}

/** Fração do jogo que ainda falta (para jogos ao vivo). */
export function remainingFraction(m: Match): number {
  if (m.status !== 'LIVE') return 1;
  if (m.minute == null) return 0.5;
  return Math.max(0, (90 - m.minute) / 90);
}

function poissonPmf(lambda: number): number[] {
  const pmf = [Math.exp(-lambda)];
  for (let k = 1; k <= MAX_GOALS; k++) pmf.push((pmf[k - 1] * lambda) / k);
  return pmf;
}

/**
 * Fator τ de Dixon-Coles: o Poisson puro erra a frequência de 0×0, 1×0, 0×1 e 1×1.
 * Com rho < 0, empates de 0×0 e 1×1 ficam mais prováveis e 1×0/0×1, menos.
 */
export function tau(h: number, a: number, lh: number, la: number, rho: number): number {
  if (h === 0 && a === 0) return 1 - lh * la * rho;
  if (h === 0 && a === 1) return 1 + lh * rho;
  if (h === 1 && a === 0) return 1 + la * rho;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}

/** matrix[h][a] = probabilidade de o mandante marcar h gols e o visitante, a. */
export function scoreMatrix(lh: number, la: number, rho = 0): number[][] {
  const ph = poissonPmf(lh);
  const pa = poissonPmf(la);
  let total = 0;
  const matrix = ph.map((p, h) =>
    pa.map((q, a) => {
      const v = Math.max(0, p * q * (rho ? tau(h, a, lh, la, rho) : 1));
      total += v;
      return v;
    }),
  );
  return matrix.map((row) => row.map((v) => v / total));
}

/**
 * Previsão a partir dos gols esperados. Para jogo ao vivo, `currentHome`/`currentAway`
 * são o placar atual e a matriz descreve só os gols que ainda vão sair.
 */
export function predict(lh: number, la: number, rho = 0, currentHome = 0, currentAway = 0): Prediction {
  const matrix = scoreMatrix(lh, la, rho);
  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  let best = -1;
  let likelyScore: [number, number] = [currentHome, currentAway];

  matrix.forEach((row, h) =>
    row.forEach((p, a) => {
      const fh = currentHome + h;
      const fa = currentAway + a;
      if (fh > fa) pHome += p;
      else if (fh === fa) pDraw += p;
      else pAway += p;
      if (p > best) {
        best = p;
        likelyScore = [fh, fa];
      }
    }),
  );

  return { expectedHome: lh, expectedAway: la, pHome, pDraw, pAway, likelyScore };
}

/** Parâmetros do que falta acontecer num jogo (o jogo todo, ou o resto dele se estiver ao vivo). */
export function remainingGoals(model: FittedModel, m: Match) {
  const xg = model.expectedGoals(m.home.id, m.away.id);
  const frac = remainingFraction(m);
  const live = m.status === 'LIVE';
  return {
    lh: xg.home * frac,
    la: xg.away * frac,
    // A correção de Dixon-Coles vale para o placar do jogo inteiro, não para o "resto" de um jogo ao vivo
    rho: live ? 0 : model.rho,
    currentHome: live ? (m.homeGoals ?? 0) : 0,
    currentAway: live ? (m.awayGoals ?? 0) : 0,
  };
}

export function predictMatch(model: FittedModel, m: Match): Prediction {
  const g = remainingGoals(model, m);
  return predict(g.lh, g.la, g.rho, g.currentHome, g.currentAway);
}
