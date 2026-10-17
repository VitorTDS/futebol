// Sul-Americana: primeira fase, grupos, playoffs e mata-mata, com dados da ESPN.
// O modelo também usa os jogos do Brasileirão e da Libertadores, para medir
// melhor os times que jogam as duas copas (ou que caíram da Libertadores).
import { createCup } from './cup.ts';
import { createEspnCupProvider, SULA_STAGES } from './data/espnCup.ts';
import type { Match, Team } from './types.ts';

export function createSulamericanaCup(opts: { year: number; extraMatches: () => Promise<Match[]>; leagueTeams: () => Promise<Team[]> }) {
  const stages = SULA_STAGES.filter(([key]) => key !== 'GROUP_STAGE').map(([key, label]) => [key, label] as [string, string]);
  return createCup({
    key: 'sula',
    name: 'Sul-Americana',
    provider: createEspnCupProvider({ league: 'conmebol.sudamericana', year: opts.year, stages: SULA_STAGES, hasGroups: true, leagueTeams: opts.leagueTeams }),
    missing: '',
    espnLeague: 'conmebol.sudamericana',
    stages,
    stageOrder: SULA_STAGES.map(([key]) => key),
    bracketFrom: 'LAST_16',
    // 1º vai direto às oitavas e 2º joga os playoffs (contra os 3º da Libertadores): os dois seguem vivos
    groupZones: { libertadores: 2, sulamericana: 0, relegation: 0 },
    extraHistory: opts.extraMatches,
  });
}
