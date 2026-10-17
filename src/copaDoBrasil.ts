// Copa do Brasil: mata-mata da primeira fase à final, com dados da ESPN.
// Na Copa do Brasil jogam clubes de todas as divisões; os jogos do Brasileirão
// entram no modelo para medir melhor os times da Série A.
import { createCup } from './cup.ts';
import { CDB_STAGES, createCopaDoBrasilProvider } from './data/copaDoBrasil.ts';
import type { Match, Team } from './types.ts';

export function createCopaDoBrasilCup(opts: { year: number; leagueMatches: () => Promise<Match[]>; leagueTeams: () => Promise<Team[]> }) {
  const stages = CDB_STAGES.map(([key, label]) => [key, label] as [string, string]);
  return createCup({
    key: 'cdb',
    name: 'Copa do Brasil',
    provider: createCopaDoBrasilProvider({ year: opts.year, leagueTeams: opts.leagueTeams }),
    missing: '',
    espnLeague: 'bra.copa_do_brazil',
    stages,
    stageOrder: stages.map(([key]) => key),
    bracketFrom: 'LAST_16',
    extraHistory: opts.leagueMatches,
  });
}
