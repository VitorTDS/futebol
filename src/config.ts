try {
  process.loadEnvFile();
} catch {
  // sem .env: usa os valores padrão
}

function parseTimeDecay(value: string | undefined): number | 'auto' {
  if (!value || value.trim().toLowerCase() === 'auto') return 'auto';
  const n = Number(value.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : 'auto';
}

export const config = {
  port: Number(process.env.PORT || 3001),
  footballDataToken: process.env.FOOTBALL_DATA_TOKEN || '',
  competition: process.env.COMPETITION || 'BSA',
  season: process.env.SEASON || undefined,
  watchUrl: process.env.WATCH_URL || 'https://globoplay.globo.com/',
  simulations: Number(process.env.SIMULATIONS || 10000),
  model: (process.env.MODEL === 'poisson' ? 'poisson' : 'dixon-coles') as 'poisson' | 'dixon-coles',
  // Dixon-Coles: quanto o peso de um jogo antigo cai por dia.
  // "auto" (padrão) = calibra pelo histórico de acertos; um número fixa o valor.
  timeDecay: parseTimeDecay(process.env.TIME_DECAY),
  /** Quantas temporadas anteriores o Dixon-Coles usa (0 = só a atual) */
  previousSeasons: Number(process.env.PREVIOUS_SEASONS ?? 1),
  /** Valor usado enquanto a calibração não termina (ou quando há poucos jogos): meia-vida de ~230 dias */
  defaultTimeDecay: 0.003,
  // Scout de jogadores (API-Football)
  apiFootballKey: process.env.APIFOOTBALL_KEY || '',
  apiFootballLeague: process.env.APIFOOTBALL_LEAGUE || '71',
  apiFootballSeason: process.env.APIFOOTBALL_SEASON || String(new Date().getFullYear()),
  /** Jogadores com menos minutos que isso ficam fora da comparação (percentis) */
  scoutMinMinutes: Number(process.env.SCOUT_MIN_MINUTES || 450),
  // Quantidade de vagas em cada zona da tabela
  zones: { libertadores: 6, sulamericana: 12, relegation: 4 },
};
