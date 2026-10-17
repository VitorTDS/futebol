// Estatísticas de jogadores da API-Football (https://www.api-football.com).
// O plano grátis permite 100 requisições por dia e 10 por minuto, e a lista de
// jogadores vem paginada (20 por página). Por isso: carrega devagar uma vez,
// salva em disco e reaproveita por 24 horas.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PlayerProvider, PlayerStats, Position } from '../../types.ts';

const BASE_URL = 'https://v3.football.api-sports.io';
const CACHE_TTL_MS = 24 * 3_600_000;
/** Intervalo entre páginas para ficar abaixo de 10 requisições por minuto */
const PAGE_DELAY_MS = 6_500;
const CACHE_DIR = path.join(import.meta.dirname, '..', '..', '..', 'data', 'cache');

interface ApiStatistics {
  team: { id: number; name: string; logo: string | null };
  league: { id: number };
  games: { appearences: number | null; minutes: number | null; position: string | null; rating: string | null };
  shots: { total: number | null; on: number | null };
  goals: { total: number | null; assists: number | null; conceded: number | null; saves: number | null };
  passes: { total: number | null; key: number | null; accuracy: number | string | null };
  tackles: { total: number | null; blocks: number | null; interceptions: number | null };
  duels: { total: number | null; won: number | null };
  dribbles: { attempts: number | null; success: number | null };
}

interface ApiPlayer {
  player: { id: number; name: string; age: number | null; nationality: string | null; photo: string | null };
  statistics: ApiStatistics[];
}

interface ApiPage {
  errors: unknown[] | Record<string, string>;
  paging: { current: number; total: number };
  response: ApiPlayer[];
}

const POSITIONS: Record<string, Position> = {
  Goalkeeper: 'Goleiro',
  Defender: 'Defensor',
  Midfielder: 'Meio-campista',
  Attacker: 'Atacante',
};

const n = (v: number | string | null | undefined) => Number(v) || 0;

/** Um jogador pode ter mais de uma linha (se trocou de time na mesma liga): soma tudo. */
function toPlayer(p: ApiPlayer, leagueId: number): PlayerStats | null {
  const stats = p.statistics.filter((s) => s.league.id === leagueId);
  if (!stats.length) return null;

  const main = stats.reduce((a, b) => (n(b.games.minutes) > n(a.games.minutes) ? b : a));
  const sum = (get: (s: ApiStatistics) => number | string | null) => stats.reduce((acc, s) => acc + n(get(s)), 0);
  const minutes = sum((s) => s.games.minutes);
  const passes = sum((s) => s.passes.total);

  // Nota e precisão de passe são médias: pondera por minutos / passes
  const rated = stats.filter((s) => n(s.games.rating) > 0);
  const ratedMinutes = rated.reduce((acc, s) => acc + n(s.games.minutes), 0);
  const rating = ratedMinutes ? rated.reduce((acc, s) => acc + n(s.games.rating) * n(s.games.minutes), 0) / ratedMinutes : null;
  const accurate = stats.filter((s) => s.passes.accuracy != null && n(s.passes.total) > 0);
  const passAccuracy = accurate.length
    ? accurate.reduce((acc, s) => acc + n(s.passes.accuracy) * n(s.passes.total), 0) / accurate.reduce((acc, s) => acc + n(s.passes.total), 0)
    : null;

  return {
    id: p.player.id,
    name: p.player.name,
    photo: p.player.photo ?? undefined,
    age: p.player.age,
    nationality: p.player.nationality,
    team: { id: main.team.id, name: main.team.name, logo: main.team.logo ?? undefined },
    position: POSITIONS[main.games.position ?? ''] ?? 'Meio-campista',
    appearances: sum((s) => s.games.appearences),
    minutes,
    rating: rating && Math.round(rating * 100) / 100,
    goals: sum((s) => s.goals.total),
    assists: sum((s) => s.goals.assists),
    shots: sum((s) => s.shots.total),
    shotsOnTarget: sum((s) => s.shots.on),
    passes,
    keyPasses: sum((s) => s.passes.key),
    passAccuracy: passAccuracy && Math.round(passAccuracy),
    tackles: sum((s) => s.tackles.total),
    interceptions: sum((s) => s.tackles.interceptions),
    blocks: sum((s) => s.tackles.blocks),
    duels: sum((s) => s.duels.total),
    duelsWon: sum((s) => s.duels.won),
    dribbles: sum((s) => s.dribbles.attempts),
    dribblesWon: sum((s) => s.dribbles.success),
    saves: sum((s) => s.goals.saves),
    conceded: sum((s) => s.goals.conceded),
  };
}

export function createApiFootballPlayerProvider(opts: { key: string; league: string; season: string }): PlayerProvider {
  const cacheFile = path.join(CACHE_DIR, `players-${opts.league}-${opts.season}.json`);
  const state = { loaded: 0, total: null as number | null, error: null as string | null, ready: false };
  let loading: Promise<PlayerStats[]> | null = null;

  async function fetchPage(page: number): Promise<ApiPage> {
    const url = `${BASE_URL}/players?league=${opts.league}&season=${opts.season}&page=${page}`;
    const res = await fetch(url, { headers: { 'x-apisports-key': opts.key } });
    if (!res.ok) throw new Error(`API-Football respondeu ${res.status}`);
    const data = (await res.json()) as ApiPage;
    // A API devolve 200 mesmo com erro (chave inválida, limite estourado, temporada fora do plano)
    const errors = Array.isArray(data.errors) ? data.errors : Object.values(data.errors ?? {});
    if (errors.length) throw new Error(`API-Football: ${errors.map(String).join('; ')}`);
    return data;
  }

  async function readCache(): Promise<PlayerStats[] | null> {
    try {
      const cached = JSON.parse(await readFile(cacheFile, 'utf8')) as { savedAt: number; players: PlayerStats[] };
      return Date.now() - cached.savedAt < CACHE_TTL_MS ? cached.players : null;
    } catch {
      return null;
    }
  }

  async function load(): Promise<PlayerStats[]> {
    const cached = await readCache();
    if (cached) {
      Object.assign(state, { ready: true, loaded: cached.length, total: cached.length });
      return cached;
    }

    const raw: ApiPlayer[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      if (page > 1) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
      const data = await fetchPage(page);
      totalPages = data.paging.total;
      raw.push(...data.response);
      state.loaded = raw.length;
      state.total = totalPages * 20;
      page++;
    } while (page <= totalPages);

    const league = Number(opts.league);
    const players = raw.map((p) => toPlayer(p, league)).filter((p): p is PlayerStats => p !== null);
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cacheFile, JSON.stringify({ savedAt: Date.now(), players }));
    Object.assign(state, { ready: true, loaded: players.length, total: players.length });
    return players;
  }

  let current: { players: PlayerStats[]; loadedAt: number } | null = null;

  function startLoading() {
    state.error = null;
    loading = load()
      .then((players) => {
        current = { players, loadedAt: Date.now() };
        return players;
      })
      .catch((err: Error) => {
        state.error = err.message;
        throw err;
      })
      .finally(() => {
        loading = null;
      });
    loading.catch(() => {}); // o erro fica em state.error; evita "unhandled rejection"
    return loading;
  }

  return {
    name: 'API-Football',
    status: () => ({ ...state, ready: current !== null }),
    getPlayers() {
      if (current) {
        // Dados vencidos: atualiza em segundo plano e continua mostrando os antigos
        if (Date.now() - current.loadedAt > CACHE_TTL_MS && !loading) startLoading();
        return Promise.resolve(current.players);
      }
      return loading ?? startLoading();
    },
  };
}
