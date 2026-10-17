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

export type ResilientProvider = DataProvider & { health(): SourceHealth };

export function resilient(provider: DataProvider, label: string): ResilientProvider {
  let last: Match[] | null = null;
  let lastOk: string | null = null;
  let failingSince: string | null = null;
  let error: string | null = null;

  return {
    ...provider,
    async getMatches() {
      try {
        const matches = await provider.getMatches();
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
    },
    health: () => ({ ok: !failingSince, lastOk, failingSince, error }),
  };
}
