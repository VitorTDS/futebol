// Copas pela ESPN (Copa do Brasil, Sul-Americana): a football-data não tem essas
// copas no plano grátis. Clubes da Série A ficam com o mesmo id da football-data
// (via ESPN_TEAMS), para as vagas e os alertas baterem com o Brasileirão; os
// outros ganham um id próprio.
import { cached } from './cache.ts';
import { ESPN_TEAMS, type EspnLeague } from './espn.ts';
import { isMatchTime } from '../model/liveEvents.ts';
import type { DataProvider, Match, MatchStatus, Team } from '../types.ts';

const BASE_URL = 'https://site.api.espn.com/apis';

/** Fase no painel, nome e fase na ESPN (season.slug) */
export type EspnStage = [key: string, label: string, espn: string];

export const CDB_STAGES: EspnStage[] = [
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

export const SULA_STAGES: EspnStage[] = [
  ['ROUND_1', 'Primeira fase', 'first-stage'],
  ['GROUP_STAGE', 'Fase de grupos', 'group-stage'],
  ['KNOCKOUT_PLAYOFFS', 'Playoffs', 'knockout-round-playoffs'],
  ['LAST_16', 'Oitavas de final', 'round-of-16'],
  ['QUARTER_FINALS', 'Quartas de final', 'quarterfinals'],
  ['SEMI_FINALS', 'Semifinal', 'semifinals'],
  ['FINAL', 'Final', 'final'],
];

/** Clubes de fora da Série A: id da ESPN somado a isto, para não colidir com a football-data */
const OTHER_TEAM_OFFSET = 9_000_000;
const FROM_ESPN = new Map(Object.entries(ESPN_TEAMS).map(([fd, espn]) => [espn, Number(fd)]));
const teamId = (espnId: string | number) => FROM_ESPN.get(String(espnId)) ?? OTHER_TEAM_OFFSET + Number(espnId);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function toTeam(c: Json, known: Map<number, Team>): Team {
  const t = c.team ?? {};
  if (/^TBD/i.test(t.displayName ?? '')) return { id: -Number(c.id), name: 'A definir', shortName: 'A definir', tla: '?', tbd: true };
  const id = teamId(t.id);
  // Série A: mesmo nome e escudo do Brasileirão
  if (known.has(id)) return known.get(id)!;
  return {
    id,
    name: t.displayName ?? t.name,
    shortName: t.shortDisplayName ?? t.displayName,
    tla: (t.abbreviation ?? '').slice(0, 4).toUpperCase(),
    crest: t.logo || undefined,
  };
}

function toMatch(ev: Json, known: Map<number, Team>, stageBySlug: Map<string, string>, groupOf: Map<number, string>): Match {
  const comp = ev.competitions?.[0] ?? {};
  const cs: Json[] = comp.competitors ?? [];
  const home = cs.find((c) => c.homeAway === 'home') ?? cs[0];
  const away = cs.find((c) => c !== home);
  const type = ev.status?.type ?? {};
  const status: MatchStatus = type.state === 'in' ? 'LIVE' : type.state === 'post' && type.completed ? 'FINISHED' : 'SCHEDULED';
  const goals = (c: Json) => (status === 'SCHEDULED' ? null : Number(c.score ?? 0));
  const pens = home.shootoutScore != null && away.shootoutScore != null ? ([Number(home.shootoutScore), Number(away.shootoutScore)] as [number, number]) : null;
  const h = toTeam(home, known);
  const a = toTeam(away, known);
  const stage = stageBySlug.get(ev.season?.slug) ?? 'ROUND_1';
  // Grupo: só quando os dois times estão no mesmo grupo da tabela da ESPN
  const group = stage === 'GROUP_STAGE' && groupOf.get(h.id) && groupOf.get(h.id) === groupOf.get(a.id) ? groupOf.get(h.id)! : null;
  return {
    id: Number(ev.id),
    matchday: 0,
    utcDate: new Date(ev.date).toISOString(),
    status,
    home: h,
    away: a,
    homeGoals: goals(home),
    awayGoals: goals(away),
    minute: status === 'LIVE' ? parseInt(ev.status?.displayClock, 10) || null : null,
    stage,
    group,
    penalties: pens,
  };
}

async function getJson(url: string): Promise<Json> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`ESPN respondeu ${res.status}`);
  return res.json();
}

/** Time → grupo ("GROUP_A"), pela tabela da ESPN; vazio se a copa não tem grupos */
async function groups(league: EspnLeague, year: number): Promise<Map<number, string>> {
  const data = await cached(`espn-groups-${league}-${year}`, 6 * 3_600_000, () =>
    getJson(`${BASE_URL}/v2/sports/soccer/${league}/standings?season=${year}`),
  );
  const out = new Map<number, string>();
  for (const g of data.children ?? []) {
    const letter = String(g.name ?? '').replace(/^Group\s+/i, '');
    for (const e of g.standings?.entries ?? []) out.set(teamId(e.team.id), `GROUP_${letter}`);
  }
  return out;
}

/**
 * `leagueTeams` devolve os times do Brasileirão, para os clubes da Série A
 * aparecerem com o mesmo nome e escudo em todas as competições.
 */
export function createEspnCupProvider(opts: {
  league: EspnLeague;
  year: number;
  stages: EspnStage[];
  /** A copa tem fase de grupos (busca a tabela para saber o grupo de cada time) */
  hasGroups?: boolean;
  leagueTeams: () => Promise<Team[]>;
}): DataProvider {
  const stageBySlug = new Map(opts.stages.map(([key, , slug]) => [slug, key]));
  let ttl = 5 * 60_000;
  const known = async () => new Map((await opts.leagueTeams().catch(() => [] as Team[])).map((t) => [t.id, t]));

  async function season(year: number, ttlMs: number, k: Map<number, Team>): Promise<Match[]> {
    const data = await cached(`espn-cup-${opts.league}-${year}`, ttlMs, () =>
      getJson(`${BASE_URL}/site/v2/sports/soccer/${opts.league}/scoreboard?dates=${year}&limit=1000`),
    );
    const groupOf = opts.hasGroups ? await groups(opts.league, year).catch(() => new Map<number, string>()) : new Map<number, string>();
    return (data.events ?? []).map((ev: Json) => toMatch(ev, k, stageBySlug, groupOf));
  }

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
