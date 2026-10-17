// Fila de trabalhos para a thread de backtests (backtestWorker.ts). Uma thread só,
// criada na primeira vez que é usada; se ela cair, a próxima chamada cria outra.
import { Worker } from 'node:worker_threads';
import type { BacktestJob, HistoryJobResult } from './backtestWorker.ts';
import type { Calibration } from './calibration.ts';

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./backtestWorker.ts', import.meta.url));
  w.on('message', ({ id, result, error }: { id: number; result?: unknown; error?: string }) => {
    const p = pending.get(id);
    pending.delete(id);
    if (error) p?.reject(new Error(error));
    else p?.resolve(result);
  });
  const fail = (err: Error) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    if (worker === w) worker = null;
  };
  w.on('error', fail);
  w.on('exit', (code) => fail(new Error(`a thread de backtests parou (código ${code})`)));
  // Não segura o processo aberto só por causa da thread
  w.unref();
  worker = w;
  return w;
}

function run<T>(job: BacktestJob): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    getWorker().postMessage({ id, job });
  });
}

export const historyOffThread = (job: Omit<Extract<BacktestJob, { type: 'history' }>, 'type'>) =>
  run<HistoryJobResult>({ type: 'history', ...job });

export const calibrateOffThread = (job: Omit<Extract<BacktestJob, { type: 'calibrate' }>, 'type'>) =>
  run<Calibration>({ type: 'calibrate', ...job });
