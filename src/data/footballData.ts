import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cached } from './cache.ts';
import { isMatchTime } from '../model/liveEvents.ts';
import { keepFinished, staleMatchdays } from './repair.ts';
import type { DataProvider, Match, MatchStatus, Scorer, Team } from '../types.ts';

const BASE_URL = 'https://api.football-data.org/v4';
// Plano grátis: 10 requisições por minuto. Em hora de jogo os placares são
// buscados a cada 15 s (4 por minuto), fora dela a cada minuto.
const TTL_MS = 60_000;
const LIVE_TTL_MS = 15_000;
const CACHE_DIR = path.join(import.meta.dirname, '..', '..', 'data', 'cache');

interface ApiTeam {
  id: number | null;
  name: string | null;
  shortName: string | null;
  tla: string | null;
  crest: string | null;
}

interface ApiMatch {
  id: number;
  matchday: number | null;
  stage?: string;
  group?: string | null;
  utcDate: string;
  status: string;
  minute?: number | string | null;
  homeTeam: ApiTeam;
  awayTeam: ApiTeam;
  score: {
    fullTime: { home: number | null; away: number | null };
    penalties?: { home: number | null; away: number | null } | null;
  };
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

function toTeam(t: ApiTeam, placeholderId: number): Team {
  // Vaga de mata-mata ainda sem dono: a API manda o time todo como null
  if (t.id == null || !t.name) return { id: placeholderId, name: 'A definir', shortName: 'A definir', tla: '?', tbd: true };
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

  // Jogos adiados, suspensos ou cancelados: não são "atrasados", só não têm data
  const inactive = new Set<number>();

  async function fetchMatches(season?: string, matchday?: number): Promise<Match[]> {
    const query = matchday ? `?matchday=${matchday}` : '';
    const data = await get<{ matches: ApiMatch[] }>(`/competitions/${opts.competition}/matches${query}`, season);
    for (const m of data.matches) {
      if (['POSTPONED', 'SUSPENDED', 'CANCELLED'].includes(m.status)) inactive.add(m.id);
      else inactive.delete(m.id);
    }
    return data.matches.map((m): Match => {
      // Em disputa de pênaltis, a API soma os pênaltis ao placar: separa os dois
      const pen = m.score.penalties;
      const penalties: [number, number] | null = pen?.home != null && pen.away != null ? [pen.home, pen.away] : null;
      const goals = (v: number | null, p: number | undefined) => (v == null ? null : v - (p ?? 0));
      return {
        id: m.id,
        matchday: m.matchday ?? 0,
        utcDate: m.utcDate,
        status: toStatus(m.status),
        home: toTeam(m.homeTeam, -m.id * 10 - 1),
        away: toTeam(m.awayTeam, -m.id * 10 - 2),
        homeGoals: goals(m.score.fullTime.home, penalties?.[0]),
        awayGoals: goals(m.score.fullTime.away, penalties?.[1]),
        minute: m.minute != null ? Number(m.minute) || null : null,
        stage: m.stage,
        group: m.group ?? null,
        penalties,
      };
    });
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

  let matchTime = false;
  // Resultados encerrados já vistos, guardados em disco (ver repair.ts)
  const finishedFile = path.join(CACHE_DIR, `football-data-${opts.competition}-encerrados.json`);
  let finishedMemory: Map<number, Match> | null = null;

  async function loadFinished(): Promise<Map<number, Match>> {
    if (!finishedMemory) {
      try {
        const saved = JSON.parse(await readFile(finishedFile, 'utf8')) as Match[];
        finishedMemory = new Map(saved.map((m) => [m.id, m]));
      } catch {
        finishedMemory = new Map();
      }
    }
    return finishedMemory;
  }

  async function currentMatches(): Promise<Match[]> {
    const memory = await loadFinished();
    let { matches, learned } = keepFinished(await fetchMatches(), memory);

    // Jogo que já devia ter acabado e veio sem resultado: busca só a rodada dele
    // de novo (a consulta por rodada costuma estar certa). No máximo 2 por vez,
    // por causa do limite de requisições do plano grátis.
    for (const md of staleMatchdays(matches, inactive).slice(0, 2)) {
      const fixed = keepFinished(await fetchMatches(undefined, md), memory);
      if (fixed.learned) {
        learned = true;
        console.warn(`football-data: rodada ${md} veio sem resultados na lista completa; corrigida pela consulta da rodada.`);
      }
      matches = keepFinished(matches, memory).matches;
    }

    if (learned) {
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(finishedFile, JSON.stringify([...memory.values()]));
    }
    return matches;
  }

  const getMatches = () =>
    cached(`matches-${opts.competition}`, matchTime ? LIVE_TTL_MS : TTL_MS, async () => {
      const matches = await currentMatches();
      matchTime = isMatchTime(matches);
      return matches;
    });

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
      cached(`scorers-${opts.competition}`, TTL_MS, async () => {
        const data = await get<{ scorers: ApiScorer[] }>(
          `/competitions/${opts.competition}/scorers?limit=30`,
        );
        return data.scorers.map(
          (s): Scorer => ({
            player: s.player.name,
            team: toTeam(s.team, 0),
            goals: s.goals,
            assists: s.assists,
            penalties: s.penalties,
          }),
        );
      }),
  };
}
