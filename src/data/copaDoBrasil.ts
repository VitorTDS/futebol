// Copa do Brasil pela ESPN: a football-data não tem essa copa no plano grátis.
// Clubes da Série A ficam com o mesmo id da football-data (via ESPN_TEAMS), para
// as vagas e os alertas baterem com o Brasileirão; os outros ganham um id próprio.
import { cached } from './cache.ts';
import { ESPN_TEAMS } from './espn.ts';
import { isMatchTime } from '../model/liveEvents.ts';
import type { DataProvider, Match, MatchStatus, Team } from '../types.ts';

const URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.copa_do_brazil/scoreboard';

/** Fase na ESPN (season.slug) → fase no painel */
export const CDB_STAGES: [key: string, label: string, espn: string][] = [
  ['ROUND_1', 'Primeira fase', 'first-round'],
  ['ROUND_2', 'Segunda fase', 'second-round'],
  ['ROUND_3', 'Terceira fase', 'third-round'],
  ['ROUND_4', 'Quarta fase', 'fourth-round'],
  ['ROUND_5', 'Quinta fase', 'fifth-round'],
  ['LAST_16', 'Oitavas de final', 'round-of-16'],
  ['QUARTER_FINALS', 'Quartas de final', 'quarterfinals'],
  ['SEMI_FINALS', 'Semifinal', 'semifinals'],
  ['FINAL', 'Final', 'final'],
];
const STAGE_BY_SLUG = new Map(CDB_STAGES.map(([key, , slug]) => [slug, key]));

/** Clubes de fora da Série A: id da ESPN somado a isto, para não colidir com a football-data */
const OTHER_TEAM_OFFSET = 9_000_000;
const FROM_ESPN = new Map(Object.entries(ESPN_TEAMS).map(([fd, espn]) => [espn, Number(fd)]));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function toTeam(c: Json, known: Map<number, Team>): Team {
  const t = c.team ?? {};
  if (/^TBD/i.test(t.displayName ?? '')) return { id: -Number(c.id), name: 'A definir', shortName: 'A definir', tla: '?', tbd: true };
  const fd = FROM_ESPN.get(String(t.id));
  // Série A: mesmo nome e escudo do Brasileirão
  if (fd && known.has(fd)) return known.get(fd)!;
  return {
    id: fd ?? OTHER_TEAM_OFFSET + Number(t.id),
    name: t.displayName ?? t.name,
    shortName: t.shortDisplayName ?? t.displayName,
    tla: (t.abbreviation ?? '').slice(0, 4).toUpperCase(),
    crest: t.logo || undefined,
  };
}

function toMatch(ev: Json, known: Map<number, Team>): Match {
  const comp = ev.competitions?.[0] ?? {};
  const cs: Json[] = comp.competitors ?? [];
  const home = cs.find((c) => c.homeAway === 'home') ?? cs[0];
  const away = cs.find((c) => c !== home);
  const type = ev.status?.type ?? {};
  const status: MatchStatus = type.state === 'in' ? 'LIVE' : type.state === 'post' && type.completed ? 'FINISHED' : 'SCHEDULED';
  const goals = (c: Json) => (status === 'SCHEDULED' ? null : Number(c.score ?? 0));
  const pens = home.shootoutScore != null && away.shootoutScore != null ? ([Number(home.shootoutScore), Number(away.shootoutScore)] as [number, number]) : null;
  return {
    id: Number(ev.id),
    matchday: 0,
    utcDate: new Date(ev.date).toISOString(),
    status,
    home: toTeam(home, known),
    away: toTeam(away, known),
    homeGoals: goals(home),
    awayGoals: goals(away),
    minute: status === 'LIVE' ? parseInt(ev.status?.displayClock, 10) || null : null,
    stage: STAGE_BY_SLUG.get(ev.season?.slug) ?? 'ROUND_1',
    group: null,
    penalties: pens,
  };
}

async function season(year: number, ttl: number, known: Map<number, Team>): Promise<Match[]> {
  const data = await cached(`espn-cdb-${year}`, ttl, async () => {
    const res = await fetch(`${URL}?dates=${year}&limit=1000`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`ESPN respondeu ${res.status}`);
    return res.json();
  });
  return (data.events ?? []).map((ev: Json) => toMatch(ev, known));
}

/**
 * `leagueTeams` devolve os times do Brasileirão, para os clubes da Série A
 * aparecerem com o mesmo nome e escudo nas duas competições.
 */
export function createCopaDoBrasilProvider(opts: { year: number; leagueTeams: () => Promise<Team[]> }): DataProvider {
  let ttl = 5 * 60_000;
  const known = async () => new Map((await opts.leagueTeams().catch(() => [] as Team[])).map((t) => [t.id, t]));
  return {
    name: 'ESPN',
    async getMatches() {
      const matches = await season(opts.year, ttl, await known());
      // Com jogo rolando, atualiza a cada 30 segundos
      ttl = isMatchTime(matches) ? 30_000 : 5 * 60_000;
      return matches;
    },
    async getScorers() {
      return null;
    },
    async getPreviousSeasons(count: number) {
      const k = await known();
      const out = [];
      for (let i = 1; i <= count; i++) out.push({ season: String(opts.year - i), matches: await season(opts.year - i, 86_400_000, k) });
      return out;
    },
  };
}
