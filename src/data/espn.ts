// Dados de cada jogo (estatísticas, lances, escalações, confronto direto) vindos da
// ESPN. É a API pública que o site da ESPN usa: não precisa de chave, mas também
// não é documentada nem garantida, então tudo aqui falha sem derrubar o painel.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cached } from './cache.ts';
import type { Match } from '../types.ts';

const BASE_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

/** Campeonato na ESPN: Brasileirão, Libertadores, Copa do Brasil ou Sul-Americana */
export type EspnLeague = 'bra.1' | 'conmebol.libertadores' | 'bra.copa_do_brazil' | 'conmebol.sudamericana';
const CACHE_DIR = path.join(import.meta.dirname, '..', '..', 'data', 'cache', 'espn');

/** id do time na football-data.org → id na ESPN */
export const ESPN_TEAMS: Record<number, string> = {
  1783: '819', // Flamengo
  1769: '2029', // Palmeiras
  1765: '3445', // Fluminense
  1766: '7632', // Atlético-MG
  1770: '6086', // Botafogo
  1776: '2026', // São Paulo
  1779: '874', // Corinthians
  6684: '1936', // Internacional
  1767: '6273', // Grêmio
  1771: '2022', // Cruzeiro
  4286: '6079', // Bragantino
  6685: '2674', // Santos
  1780: '3454', // Vasco
  1777: '9967', // Bahia
  1782: '3457', // Vitória
  1768: '3458', // Athletico-PR
  1772: '9318', // Chapecoense
  4364: '9169', // Mirassol
  4241: '3456', // Coritiba
  4287: '4936', // Remo
};

export type Side = 'home' | 'away';

export interface StatLine {
  key: string;
  label: string;
  home: number;
  away: number;
  /** Texto pronto para a tela (ex.: "56%") */
  display: [string, string];
}

export interface MatchEvent {
  minute: string;
  type: 'goal' | 'own-goal' | 'penalty' | 'missed-penalty' | 'yellow' | 'red' | 'sub';
  side: Side;
  player: string;
  /** Assistência no gol; quem saiu na substituição */
  other: string | null;
}

export interface LineupPlayer {
  number: string;
  name: string;
  fullName: string;
  position: string;
  place: number;
  subbedIn: boolean;
  subbedOut: boolean;
}

export interface Lineup {
  formation: string | null;
  starters: LineupPlayer[];
  bench: LineupPlayer[];
}

export interface HeadToHead {
  date: string;
  competition: string | null;
  homeName: string;
  homeScore: number | null;
  awayName: string;
  awayScore: number | null;
  /** Qual dos times deste jogo venceu aquele confronto (null = empate) */
  winner: Side | null;
}

export interface Leader {
  label: string;
  name: string;
  value: string;
}

export interface MatchCenter {
  url: string;
  state: 'pre' | 'in' | 'post';
  venue: { name: string; city: string | null } | null;
  /** Cores de cada time na ESPN (hex sem #): principal e alternativa */
  colors: Record<Side, { main: string | null; alt: string | null }>;
  stats: StatLine[];
  events: MatchEvent[];
  lineups: Record<Side, Lineup> | null;
  h2h: HeadToHead[];
  leaders: Record<Side, Leader[]>;
  /** Chance de cada resultado segundo as cotações das casas de apostas */
  odds: { provider: string; home: number; draw: number; away: number } | null;
}

// Respostas da ESPN: formato livre, lido campo a campo com valores padrão
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function get(league: EspnLeague, apiPath: string): Promise<Json> {
  const res = await fetch(`${BASE_URL}/${league}${apiPath}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`ESPN respondeu ${res.status}`);
  return res.json();
}

/** "2026-10-17" → "20261017" */
const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll('-', '');

function scoreboard(league: EspnLeague, date: string): Promise<Json> {
  const past = date < ymd(new Date(Date.now() - 2 * 86_400_000));
  return cached(`espn-scoreboard-${league}-${date}`, past ? 86_400_000 : 10 * 60_000, () => get(league, `/scoreboard?dates=${date}`));
}

const STOPWORDS = new Set(['fc', 'cf', 'club', 'clube', 'de', 'del', 'da', 'do', 'la', 'el', 'sc', 'ac', 'ca', 'cd', 'cr', 'ec', 'se', 'cs', 'fbc', 'afc', 'sa']);

/** Palavras que identificam um time: "CS Independiente Rivadavia" → independiente, rivadavia */
export function nameTokens(...names: (string | undefined | null)[]): Set<string> {
  const tokens = new Set<string>();
  for (const n of names) {
    // Tira acentos (separa a letra do acento e apaga o acento)
    for (const w of (n ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length > 1 && !STOPWORDS.has(w)) tokens.add(w);
    }
  }
  return tokens;
}

function sameTeam(ours: Match['home'], espnTeam: Json): boolean {
  const mapped = ESPN_TEAMS[ours.id];
  if (mapped) return String(espnTeam?.id) === mapped;
  const theirs = nameTokens(espnTeam?.displayName, espnTeam?.shortDisplayName, espnTeam?.name, espnTeam?.location);
  return [...nameTokens(ours.name, ours.shortName)].some((t) => theirs.has(t));
}

/**
 * Acha o jogo correspondente na ESPN (mesmos times, mesmo dia) e o id do
 * mandante lá. Times brasileiros vão pelo id; os outros, pelo nome.
 */
export async function findEspnEvent(match: Match, league: EspnLeague = 'bra.1'): Promise<{ eventId: string; homeEspnId: string } | null> {
  if (match.home.tbd || match.away.tbd) return null;
  // A ESPN agrupa os jogos pelo dia no fuso dos EUA: procura no dia em UTC e no anterior
  const kickoff = new Date(match.utcDate);
  for (const date of new Set([ymd(kickoff), ymd(new Date(kickoff.getTime() - 86_400_000))])) {
    const board = await scoreboard(league, date);
    for (const ev of board.events ?? []) {
      const competitors: Json[] = ev.competitions?.[0]?.competitors ?? [];
      const home = competitors.find((c) => sameTeam(match.home, c.team));
      const away = competitors.find((c) => c !== home && sameTeam(match.away, c.team));
      if (home && away) return { eventId: String(ev.id), homeEspnId: String(home.team.id) };
    }
  }
  return null;
}

const STAT_LABELS: [key: string, label: string, kind?: 'pct' | 'ratio'][] = [
  ['possessionPct', 'Posse de bola', 'pct'],
  ['totalShots', 'Finalizações'],
  ['shotsOnTarget', 'Finalizações no gol'],
  ['totalPasses', 'Passes'],
  ['accuratePasses', 'Passes certos'],
  ['passPct', 'Precisão dos passes', 'ratio'],
  ['wonCorners', 'Escanteios'],
  ['foulsCommitted', 'Faltas'],
  ['yellowCards', 'Cartões amarelos'],
  ['redCards', 'Cartões vermelhos'],
  ['offsides', 'Impedimentos'],
  ['saves', 'Defesas do goleiro'],
  ['totalCrosses', 'Cruzamentos'],
  ['totalTackles', 'Desarmes'],
  ['interceptions', 'Interceptações'],
];

const LEADER_LABELS: Record<string, string> = {
  goalsLeaders: 'Artilheiro',
  assistsLeaders: 'Assistências',
  totalShots: 'Finalizações',
  accuratePasses: 'Passes certos',
  saves: 'Defesas',
};

/** Cotação americana → chance implícita (antes de tirar a margem da casa). */
function implied(moneyLine: number): number {
  return moneyLine > 0 ? 100 / (moneyLine + 100) : -moneyLine / (-moneyLine + 100);
}

function eventType(ev: Json): MatchEvent['type'] | null {
  const t = String(ev.type?.type ?? '').toLowerCase();
  const text = String(ev.type?.text ?? '').toLowerCase();
  if (t.includes('own') || text.includes('own goal')) return 'own-goal';
  if ((t.includes('penalty') || text.includes('penalty')) && (t.includes('miss') || t.includes('saved') || text.includes('miss') || text.includes('saved'))) return 'missed-penalty';
  if (t.includes('penalty') || text.includes('penalty')) return ev.scoringPlay ? 'penalty' : null;
  if (t.includes('goal') || ev.scoringPlay) return 'goal';
  if (t.includes('red') || text.includes('red card')) return 'red';
  if (t.includes('yellow') || text.includes('yellow')) return 'yellow';
  if (t.includes('substitution')) return 'sub';
  return null;
}

/** Converte o resumo da ESPN para o formato do painel (`homeEspnId`: id do mandante na ESPN). */
export function normalizeSummary(eventId: string, s: Json, homeEspnId: string): MatchCenter {
  const sideOf = (teamId: unknown): Side => (String(teamId) === homeEspnId ? 'home' : 'away');
  const comp = s.header?.competitions?.[0] ?? {};

  const box: Record<Side, Map<string, Json>> = { home: new Map(), away: new Map() };
  for (const t of s.boxscore?.teams ?? []) {
    for (const st of t.statistics ?? []) box[sideOf(t.team?.id)].set(st.name, st);
  }
  const stats: StatLine[] = [];
  // Antes do jogo a ESPN manda só números da temporada (gols etc.): não são estatísticas do jogo
  if (box.home.has('possessionPct')) {
    for (const [key, label, kind] of STAT_LABELS) {
      const h = box.home.get(key);
      const a = box.away.get(key);
      if (!h || !a) continue;
      const hv = Number(h.displayValue);
      const av = Number(a.displayValue);
      if (!Number.isFinite(hv) || !Number.isFinite(av)) continue;
      const fmt = (v: number) =>
        kind === 'pct' ? `${Math.round(v)}%` : kind === 'ratio' ? `${Math.round(v * 100)}%` : String(v);
      stats.push({ key, label, home: hv, away: av, display: [fmt(hv), fmt(av)] });
    }
    // A ESPN arredonda a precisão dos passes (0.9); dá para calcular certinho
    const ph = Number(box.home.get('accuratePasses')?.displayValue) / Number(box.home.get('totalPasses')?.displayValue);
    const pa = Number(box.away.get('accuratePasses')?.displayValue) / Number(box.away.get('totalPasses')?.displayValue);
    const line = stats.find((x) => x.key === 'passPct');
    if (line && Number.isFinite(ph) && Number.isFinite(pa)) {
      line.home = ph;
      line.away = pa;
      line.display = [`${Math.round(ph * 100)}%`, `${Math.round(pa * 100)}%`];
    }
  }

  const events: MatchEvent[] = [];
  for (const ev of s.keyEvents ?? []) {
    const type = eventType(ev);
    if (!type || !ev.team) continue;
    const names = (ev.participants ?? []).map((p: Json) => p.athlete?.displayName).filter(Boolean);
    if (!names.length) continue;
    events.push({
      minute: ev.clock?.displayValue ?? '',
      type,
      side: sideOf(ev.team.id),
      player: names[0],
      other: names[1] ?? null,
    });
  }

  let lineups: Record<Side, Lineup> | null = null;
  const rosters = s.rosters ?? [];
  if (rosters.length === 2 && rosters.every((r: Json) => (r.roster ?? []).length)) {
    const toPlayer = (p: Json): LineupPlayer => ({
      number: String(p.jersey ?? ''),
      name: p.athlete?.shortName ?? p.athlete?.displayName ?? '',
      fullName: p.athlete?.displayName ?? '',
      position: p.position?.abbreviation ?? '',
      place: Number(p.formationPlace) || 0,
      subbedIn: Boolean(p.subbedIn),
      subbedOut: Boolean(p.subbedOut),
    });
    lineups = { home: { formation: null, starters: [], bench: [] }, away: { formation: null, starters: [], bench: [] } };
    for (const r of rosters) {
      const side = sideOf(r.team?.id);
      lineups[side] = {
        formation: r.formation ?? null,
        starters: r.roster.filter((p: Json) => p.starter).map(toPlayer),
        bench: r.roster.filter((p: Json) => !p.starter).map(toPlayer),
      };
    }
  }

  const h2h: HeadToHead[] = [];
  for (const series of s.seasonseries ?? []) {
    if (series.type !== 'head-to-head') continue;
    for (const ev of series.events ?? []) {
      if (ev.statusType?.completed === false) continue;
      const home = ev.competitors?.find((c: Json) => c.homeAway === 'home');
      const away = ev.competitors?.find((c: Json) => c.homeAway === 'away');
      if (!home || !away) continue;
      const homeScore = home.score != null ? Number(home.score) : null;
      const awayScore = away.score != null ? Number(away.score) : null;
      const winnerTeam = homeScore == null || awayScore == null || homeScore === awayScore ? null : homeScore > awayScore ? home : away;
      h2h.push({
        date: ev.date,
        competition: ev.leagueName ?? null,
        homeName: home.team?.displayName ?? '',
        homeScore,
        awayName: away.team?.displayName ?? '',
        awayScore,
        winner: winnerTeam ? sideOf(winnerTeam.team?.id) : null,
      });
    }
  }
  h2h.sort((a, b) => b.date.localeCompare(a.date));

  const leaders: Record<Side, Leader[]> = { home: [], away: [] };
  for (const t of s.leaders ?? []) {
    const side = sideOf(t.team?.id);
    for (const cat of t.leaders ?? []) {
      const label = LEADER_LABELS[cat.name];
      const top = cat.leaders?.[0];
      if (!label || !top) continue;
      // "Matches: 23, Goals: 10" → "10"
      const value = String(top.displayValue ?? top.value ?? '').split(':').pop()!.trim();
      leaders[side].push({ label, name: top.athlete?.displayName ?? '', value });
    }
  }

  let odds: MatchCenter['odds'] = null;
  const pick = (s.pickcenter ?? [])[0];
  const ml = [pick?.homeTeamOdds?.moneyLine, pick?.drawOdds?.moneyLine, pick?.awayTeamOdds?.moneyLine].map(Number);
  if (pick && ml.every((x) => Number.isFinite(x) && x !== 0)) {
    // As cotações somam mais de 100% (margem da casa): normaliza
    const [h, d, a] = ml.map(implied);
    const total = h + d + a;
    odds = { provider: pick.provider?.name ?? 'casas de apostas', home: h / total, draw: d / total, away: a / total };
  }

  const colors: MatchCenter['colors'] = { home: { main: null, alt: null }, away: { main: null, alt: null } };
  for (const c of comp.competitors ?? []) {
    colors[c.homeAway === 'home' ? 'home' : 'away'] = { main: c.team?.color ?? null, alt: c.team?.alternateColor ?? null };
  }

  const venue = s.gameInfo?.venue;
  return {
    url: `https://www.espn.com.br/futebol/partida/_/jogoId/${eventId}`,
    state: comp.status?.type?.state ?? 'pre',
    venue: venue ? { name: venue.fullName, city: venue.address?.city ?? null } : null,
    colors,
    stats,
    events,
    lineups,
    h2h,
    leaders,
    odds,
  };
}

/** Resumo de um jogo terminado não muda mais: fica guardado em disco. */
async function summary(league: EspnLeague, eventId: string, match: Match): Promise<Json> {
  const file = path.join(CACHE_DIR, `${eventId}.json`);
  if (match.status === 'FINISHED') {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      // ainda não está em disco
    }
  }
  const soon = Math.abs(Date.parse(match.utcDate) - Date.now()) < 3 * 3_600_000;
  const ttl = match.status === 'LIVE' ? 30_000 : soon ? 2 * 60_000 : 10 * 60_000;
  const data = await cached(`espn-summary-${eventId}`, ttl, () => get(league, `/summary?event=${eventId}`));
  if (match.status === 'FINISHED' && data.header?.competitions?.[0]?.status?.type?.completed) {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(file, JSON.stringify(data));
  }
  return data;
}

export async function getMatchCenter(match: Match, league: EspnLeague = 'bra.1'): Promise<MatchCenter | null> {
  const found = await findEspnEvent(match, league);
  if (!found) return null;
  return normalizeSummary(found.eventId, await summary(league, found.eventId, match), found.homeEspnId);
}
