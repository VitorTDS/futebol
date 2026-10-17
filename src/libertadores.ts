// Libertadores: grupos, mata-mata, chance de título e páginas de jogo e de time.
// Dados da football-data (competição CLI), a mesma fonte do Brasileirão.
import { config } from './config.ts';
import { createCup } from './cup.ts';
import { createFootballDataProvider } from './data/footballData.ts';
import { KNOCKOUT_STAGES } from './model/knockout.ts';

export const libertadoresCup = createCup({
  key: 'lib',
  name: 'Libertadores',
  provider: config.footballDataToken ? createFootballDataProvider({ token: config.footballDataToken, competition: 'CLI' }) : null,
  missing: 'A Libertadores precisa do token da football-data (FOOTBALL_DATA_TOKEN no .env).',
  espnLeague: 'conmebol.libertadores',
  stages: KNOCKOUT_STAGES,
  stageOrder: ['ROUND_1', 'ROUND_2', 'ROUND_3', 'GROUP_STAGE', 'PLAY_OFFS', 'QUARTER_FINALS', 'SEMI_FINALS', 'FINAL'],
  bracketFrom: 'PLAY_OFFS',
  // Nos grupos, 1º e 2º vão às oitavas e o 3º cai para a Sul-Americana
  groupZones: { libertadores: 2, sulamericana: 3, relegation: 0 },
});
