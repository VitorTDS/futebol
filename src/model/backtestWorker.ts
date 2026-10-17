// Roda o histórico de acertos (backtests), a calibração do TIME_DECAY e as chances
// rodada a rodada fora da thread principal: são contas de vários segundos que, na thread do servidor,
// travariam todas as respostas (o "e se", a tabela, o ao vivo) enquanto rodam.
import { parentPort } from 'node:worker_threads';
import type { ContinentalCups } from '../data/copas.ts';
import { backtest, type BacktestResult } from './backtest.ts';
import { calibrateTimeDecay } from './calibration.ts';
import { createCupSimulator, type SpotRules } from './cups.ts';
import type { Background } from './models.ts';
import { fitModel, MODEL_KINDS } from './models.ts';
import type { ModelKind } from './prediction.ts';
import { mulberry32 } from './random.ts';
import { simulateSeason } from './simulation.ts';
import { isFinished } from './standings.ts';
import type { Match, Team } from '../types.ts';

export type BacktestJob =
  | {
      type: 'history';
      teams: Team[];
      matches: Match[];
      decay: number;
      background: Background | null;
      /** Modelos que já vêm prontos (ex.: o Dixon-Coles que a calibração calculou) */
      skip: ModelKind[];
    }
  | { type: 'calibrate'; teams: Team[]; matches: Match[]; defaultDecay: number; background: Background | null }
  | {
      type: 'chances';
      model: ModelKind;
      teams: Team[];
      matches: Match[];
      decay: number;
      background: Background | null;
      zones: SpotRules & { relegation: number };
      cups: ContinentalCups | null;
      runs: number;
    };

/** Chances de cada time ao fim de cada rodada (rodada 0 = antes de a bola rolar) */
export interface ChancesJobResult {
  rounds: number[];
  teams: { teamId: number; title: number[]; libertadores: number[]; relegation: number[] }[];
}

/**
 * Refaz o passado: para cada rodada, esquece os jogos que vieram depois, ajusta o
 * modelo só com o que se sabia naquele dia e simula o resto do campeonato.
 */
function chancesByRound(job: Extract<BacktestJob, { type: 'chances' }>): ChancesJobResult {
  const played = job.matches.filter(isFinished);
  const lastRound = Math.max(0, ...played.map((m) => m.matchday));
  const series = new Map(job.teams.map((t) => [t.id, { teamId: t.id, title: [] as number[], libertadores: [] as number[], relegation: [] as number[] }]));
  const rounds: number[] = [];
  const firstKickoff = job.matches.map((m) => m.utcDate).sort()[0];
  for (let round = 0; round <= lastRound; round++) {
    // "Hoje", naquela rodada: o último jogo dela (jogo adiado que veio depois fica de fora)
    const ofRound = played.filter((m) => m.matchday === round).map((m) => m.utcDate);
    if (round > 0 && !ofRound.length) continue;
    const asOf = round === 0 ? new Date(Date.parse(firstKickoff) - 1).toISOString() : ofRound.sort().at(-1)!;
    const known = job.matches.map((m) =>
      isFinished(m) && m.utcDate <= asOf ? m : { ...m, status: 'SCHEDULED' as const, homeGoals: null, awayGoals: null, minute: null },
    );
    const model = fitModel(job.model, job.teams, known, asOf, job.decay, job.background);
    const out = simulateSeason(job.teams, known, model, {
      runs: job.runs,
      zones: job.zones,
      // Mesma semente em todas as rodadas: a linha muda pelos resultados, não pelo acaso
      rng: mulberry32(2026),
      cups: job.cups ? createCupSimulator(model, job.teams.map((t) => t.id), job.cups) : undefined,
    });
    rounds.push(round);
    for (const o of out.teams) {
      const s = series.get(o.teamId)!;
      s.title.push(o.title);
      s.libertadores.push(o.libertadores);
      s.relegation.push(o.relegation);
    }
  }
  return { rounds, teams: [...series.values()] };
}

export interface HistoryJobResult {
  byModel: Partial<Record<ModelKind, BacktestResult>>;
  withoutBackground: BacktestResult | null;
}

async function run(job: BacktestJob) {
  if (job.type === 'calibrate') return calibrateTimeDecay(job.teams, job.matches, job.defaultDecay, job.background);
  if (job.type === 'chances') return chancesByRound(job);
  const byModel: HistoryJobResult['byModel'] = {};
  for (const kind of MODEL_KINDS) {
    if (!job.skip.includes(kind)) byModel[kind] = backtest(kind, job.teams, job.matches, job.decay, job.background);
  }
  const withoutBackground = job.background ? backtest('dixon-coles', job.teams, job.matches, job.decay) : null;
  return { byModel, withoutBackground } satisfies HistoryJobResult;
}

parentPort?.on('message', async ({ id, job }: { id: number; job: BacktestJob }) => {
  try {
    parentPort!.postMessage({ id, result: await run(job) });
  } catch (err) {
    parentPort!.postMessage({ id, error: (err as Error).message });
  }
});
