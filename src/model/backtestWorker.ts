// Roda o histórico de acertos (backtests) e a calibração do TIME_DECAY fora da
// thread principal: são contas de vários segundos que, na thread do servidor,
// travariam todas as respostas (o "e se", a tabela, o ao vivo) enquanto rodam.
import { parentPort } from 'node:worker_threads';
import { backtest, type BacktestResult } from './backtest.ts';
import { calibrateTimeDecay } from './calibration.ts';
import type { Background } from './models.ts';
import { MODEL_KINDS } from './models.ts';
import type { ModelKind } from './prediction.ts';
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
  | { type: 'calibrate'; teams: Team[]; matches: Match[]; defaultDecay: number; background: Background | null };

export interface HistoryJobResult {
  byModel: Partial<Record<ModelKind, BacktestResult>>;
  withoutBackground: BacktestResult | null;
}

async function run(job: BacktestJob) {
  if (job.type === 'calibrate') return calibrateTimeDecay(job.teams, job.matches, job.defaultDecay, job.background);
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
