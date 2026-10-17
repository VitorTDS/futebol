import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cached } from './cache.ts';
import type { DataProvider, Match, MatchStatus, Scorer, Team } from '../types.ts';

const BASE_URL = 'https://api.football-data.org/v4';
// Plano grátis: 10 requisições por minuto
const TTL_MS = 60_000;
const CACHE_DIR = path.join(import.meta.dirname, '..', '..', 'data', 'cache');

interface ApiTeam {
  id: number;
  name: string;
  shortName: string | null;
  tla: string | null;
  crest: string | null;
}

interface ApiMatch {
  id: number;
  matchday: number;
  utcDate: string;
  status: string;
  minute?: number | string | null;
  homeTeam: ApiTeam;
  awayTeam: ApiTeam;
  score: { fullTime: { home: number | null; away: number | null } };
}

interface ApiScorer {
  player: { name: string };
  team: ApiTeam;
  goals: number;
  assists: number | null;
  penalties: number | null;
}

// A football-data.org usa siglas e nomes curtos estranhos para alguns clubes
// (Coritiba e Corinthians são os dois "COR"). Corrige pelo id do time.
const TEAM_FIXES: Record<number, { shortName?: string; tla?: string }> = {
  1766: { shortName: 'Atlético-MG' },
  1767: { tla: 'GRE' },
  1768: { shortName: 'Athletico-PR' },
  1776: { tla: 'SAO' },
  4241: { tla: 'CFC' },
  4287: { shortName: 'Remo', tla: 'REM' },
  6684: { tla: 'INT' },
};

export function fixTeam(t: Team): Team {
  return { ...t, ...TEAM_FIXES[t.id] };
}

function toTeam(t: ApiTeam): Team {
  return fixTeam({
    id: t.id,
    name: t.name,
    shortName: t.shortName ?? t.name,
    tla: t.tla ?? t.name.slice(0, 3).toUpperCase(),
    crest: t.crest ?? undefined,
  });
}

function toStatus(status: string): MatchStatus {
  if (status === 'FINISHED' || status === 'AWARDED') return 'FINISHED';
  if (status === 'IN_PLAY' || status === 'PAUSED' || status === 'LIVE') return 'LIVE';
  return 'SCHEDULED';
}

export function createFootballDataProvider(opts: {
  token: string;
  competition: string;
  season?: string;
}): DataProvider {
  async function get<T>(apiPath: string, season = opts.season): Promise<T> {
    const url = new URL(BASE_URL + apiPath);
    if (season) url.searchParams.set('season', season);

    const res = await fetch(url, { headers: { 'X-Auth-Token': opts.token } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`football-data.org respondeu ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  async function fetchMatches(season?: string): Promise<Match[]> {
    const data = await get<{ matches: ApiMatch[] }>(`/competitions/${opts.competition}/matches`, season);
    return data.matches.map(
      (m): Match => ({
        id: m.id,
        matchday: m.matchday,
        utcDate: m.utcDate,
        status: toStatus(m.status),
        home: toTeam(m.homeTeam),
        away: toTeam(m.awayTeam),
        homeGoals: m.score.fullTime.home,
        awayGoals: m.score.fullTime.away,
        minute: m.minute != null ? Number(m.minute) || null : null,
      }),
    );
  }

  /** Temporada já encerrada não muda: busca uma vez e guarda em disco para sempre. */
  async function pastSeason(season: string): Promise<Match[]> {
    const file = path.join(CACHE_DIR, `football-data-${opts.competition}-${season}.json`);
    try {
      const cachedMatches = JSON.parse(await readFile(file, 'utf8')) as Match[];
      return cachedMatches.map((m) => ({ ...m, home: fixTeam(m.home), away: fixTeam(m.away) }));
    } catch {
      // ainda não está em disco
    }
    const matches = await fetchMatches(season);
    if (matches.length && matches.every((m) => m.status === 'FINISHED')) {
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(file, JSON.stringify(matches));
    }
    return matches;
  }

  const getMatches = () => cached('matches', TTL_MS, () => fetchMatches());

  return {
    name: 'football-data.org',

    getMatches,

    async getPreviousSeasons(count) {
      // O Brasileirão cabe num ano só: a temporada é o ano dos jogos
      const current = opts.season ? Number(opts.season) : await getMatches().then((ms) => Math.min(...ms.map((m) => new Date(m.utcDate).getUTCFullYear())));
      const seasons = Array.from({ length: count }, (_, i) => String(current - 1 - i));
      const result = [];
      for (const season of seasons) result.push({ season, matches: await pastSeason(season) });
      return result;
    },

    getScorers: () =>
      cached('scorers', TTL_MS, async () => {
        const data = await get<{ scorers: ApiScorer[] }>(
          `/competitions/${opts.competition}/scorers?limit=30`,
        );
        return data.scorers.map(
          (s): Scorer => ({
            player: s.player.name,
            team: toTeam(s.team),
            goals: s.goals,
            assists: s.assists,
            penalties: s.penalties,
          }),
        );
      }),
  };
}
