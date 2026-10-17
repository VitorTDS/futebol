// Situação das copas que dão vaga extra na Libertadores 2027 pelo Brasil.
// ATUALIZE À MÃO quando sair resultado: preencha o placar (score) de cada jogo
// encerrado e, quando a final acontecer, troque `semifinals` por `decided`.
//
// Times da Série A vão pelo id da football-data.org; clubes de fora (estrangeiros
// ou de outras divisões) vão pelo nome, como texto.
//
// Regra da CBF para 2026 (Regulamento Específico da Série A):
// - Libertadores: 5 primeiros do Brasileirão + campeão e vice da Copa do Brasil
//   + campeões brasileiros da Libertadores e da Sul-Americana. Clube com vaga dupla
//   libera uma, que desce para o melhor do Brasileirão ainda sem vaga.
// - Sul-Americana: os 6 mais bem colocados que não foram para a Libertadores.

export type Side = number | string;

export interface Leg {
  home: Side;
  away: Side;
  /** Placar, se o jogo já aconteceu */
  score?: [number, number];
  /** Jogo em andamento: placar atual e quanto do jogo ainda falta (0 a 1) */
  live?: { score: [number, number]; remaining: number };
  /** Disputa de pênaltis já decidida neste jogo [mandante, visitante] */
  penalties?: [number, number] | null;
}

export interface Cup {
  name: string;
  /** Cada semifinal é uma lista de jogos (ida e volta) */
  semifinals?: [Leg[], Leg[]];
  /** Final em jogo único, em campo neutro */
  finalNeutral?: boolean;
  /** Quando a copa já acabou */
  decided?: { champion: Side; runnerUp: Side };
  /**
   * Chance de título de cada clube, vinda de uma simulação própria da copa
   * (a Libertadores usa a da aba Libertadores). Tem prioridade sobre `semifinals`.
   */
  odds?: { champion: Side; p: number }[];
}

export interface ContinentalCups {
  /** Campeão e vice ganham vaga na Libertadores */
  copaDoBrasil: Cup;
  /** Só o campeão ganha vaga, e só se for brasileiro (da Série A) */
  libertadores: Cup;
  sulamericana: Cup;
}

const FLU = 1765;
const CAM = 1766;
const GRE = 1767;
const PAL = 1769;
const VAS = 1780;
const FLA = 1783;

/** Situação em 17/10/2026 */
export const CUPS_2026: ContinentalCups = {
  copaDoBrasil: {
    name: 'Copa do Brasil',
    // Ida em 1º/11, volta em 8/11; final em jogo único em Brasília (6/12)
    semifinals: [
      [{ home: PAL, away: VAS }, { home: VAS, away: PAL }],
      [{ home: GRE, away: CAM }, { home: CAM, away: GRE }],
    ],
    finalNeutral: true,
  },
  libertadores: {
    name: 'Libertadores',
    // Volta em 21 e 22/10; final em jogo único em Montevidéu (28/11)
    semifinals: [
      [{ home: FLU, away: PAL, score: [1, 2] }, { home: PAL, away: FLU }],
      [{ home: 'Estudiantes', away: FLA, score: [0, 0] }, { home: FLA, away: 'Estudiantes' }],
    ],
    finalNeutral: true,
  },
  sulamericana: {
    name: 'Sul-Americana',
    // Volta em 20 e 21/10; final em jogo único
    semifinals: [
      [{ home: 'Boca Juniors', away: VAS, score: [0, 1] }, { home: VAS, away: 'Boca Juniors' }],
      [{ home: CAM, away: 'Montevideo City Torque', score: [3, 0] }, { home: 'Montevideo City Torque', away: CAM }],
    ],
    finalNeutral: true,
  },
};
