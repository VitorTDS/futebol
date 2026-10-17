// Quando a fonte cai (football-data ou ESPN fora do ar, limite estourado, rede),
// o painel continua mostrando os últimos placares que conseguiu, e avisa de quando são.
import type { DataProvider, Match } from '../types.ts';

export interface SourceHealth {
  ok: boolean;
  /** Última leitura que deu certo (ISO) */
  lastOk: string | null;
  /** Desde quando está falhando (ISO), se está */
  failingSince: string | null;
  error: string | null;
}

export type ResilientProvider = DataProvider & { refreshMatches(): Promise<Match[]>; health(): SourceHealth };

export function resilient(provider: DataProvider, label: string): ResilientProvider {
  let last: Match[] | null = null;
  let lastOk: string | null = null;
  let failingSince: string | null = null;
  let error: string | null = null;

  async function read(fetchMatches: () => Promise<Match[]>) {
    try {
      const matches = await fetchMatches();
      last = matches;
      lastOk = new Date().toISOString();
      if (failingSince) console.log(`${label}: fonte voltou.`);
      failingSince = null;
      error = null;
      return matches;
    } catch (err) {
      error = (err as Error).message;
      if (!failingSince) {
        failingSince = new Date().toISOString();
        console.warn(`${label}: fonte falhou (${error})${last ? '; mostrando os últimos placares' : ''}`);
      }
      if (last) return last;
      throw err;
    }
  }

  return {
    ...provider,
    getMatches: () => read(() => provider.getMatches()),
    refreshMatches: () => read(() => (provider.refreshMatches ? provider.refreshMatches() : provider.getMatches())),
    health: () => ({ ok: !failingSince, lastOk, failingSince, error }),
  };
}
