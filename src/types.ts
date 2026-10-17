export type MatchStatus = 'SCHEDULED' | 'LIVE' | 'FINISHED';

export interface Team {
  id: number;
  name: string;
  shortName: string;
  tla: string;
  crest?: string;
  /** Vaga ainda sem dono (ex.: final da Libertadores antes das semifinais) */
  tbd?: boolean;
}

export interface Match {
  id: number;
  matchday: number;
  utcDate: string;
  status: MatchStatus;
  home: Team;
  away: Team;
  homeGoals: number | null;
  awayGoals: number | null;
  minute?: number | null;
  /** Copas: fase (GROUP_STAGE, QUARTER_FINALS...), grupo e disputa de pênaltis */
  stage?: string;
  group?: string | null;
  penalties?: [number, number] | null;
}

export interface Scorer {
  player: string;
  team: Team;
  goals: number;
  assists: number | null;
  penalties: number | null;
}

export type Position = 'Goleiro' | 'Defensor' | 'Meio-campista' | 'Atacante';

/** Números da temporada de um jogador (totais, não por jogo). */
export interface PlayerStats {
  id: number;
  name: string;
  photo?: string;
  age: number | null;
  nationality: string | null;
  team: { id: number; name: string; logo?: string };
  position: Position;
  appearances: number;
  minutes: number;
  /** Nota média por jogo (0–10), quando a fonte tem */
  rating: number | null;
  goals: number;
  assists: number;
  shots: number;
  shotsOnTarget: number;
  passes: number;
  keyPasses: number;
  /** Precisão de passe em % */
  passAccuracy: number | null;
  tackles: number;
  interceptions: number;
  blocks: number;
  duels: number;
  duelsWon: number;
  dribbles: number;
  dribblesWon: number;
  saves: number;
  conceded: number;
}

export interface PlayerProvider {
  name: string;
  /** Situação do carregamento (a fonte real demora alguns minutos na primeira vez) */
  status(): { ready: boolean; loaded: number; total: number | null; error: string | null };
  /** Começa a carregar se ainda não começou; resolve quando tudo estiver pronto */
  getPlayers(): Promise<PlayerStats[]>;
}

export interface DataProvider {
  name: string;
  getMatches(): Promise<Match[]>;
  /** Busca agora, sem usar o que está guardado (o "ao vivo" usa para não atrasar os gols) */
  refreshMatches?(): Promise<Match[]>;
  /** null quando a fonte não tem artilharia */
  getScorers(): Promise<Scorer[] | null>;
  /** Jogos das `count` temporadas anteriores à atual (a mais recente primeiro) */
  getPreviousSeasons(count: number): Promise<{ season: string; matches: Match[] }[]>;
}
