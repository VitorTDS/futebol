import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { config } from './config.ts';
import { createFootballDataProvider } from './data/footballData.ts';
import { createMockProvider } from './data/mock.ts';
import { createApiFootballPlayerProvider } from './data/players/apiFootball.ts';
import { createMockPlayerProvider } from './data/players/mock.ts';
import { backtest, type BacktestResult } from './model/backtest.ts';
import { calibrateTimeDecay, halfLife, MIN_MATCHES, type Calibration } from './model/calibration.ts';
import { buildBackground, fitModel, MODEL_KINDS, type Background } from './model/models.ts';
import { MODEL_LABELS, predictMatch, topScores, type FittedModel, type ModelKind } from './model/prediction.ts';
import { mulberry32 } from './model/random.ts';
import { createCupSimulator } from './model/cups.ts';
import { isMatchTime, liveEvents } from './model/liveEvents.ts';
import { applyPick, pickedScores, type Pick } from './model/whatif.ts';
import { simulateSeason, type TeamOutlook, type ZoneOutlook } from './model/simulation.ts';
import { CUPS_2026, type ContinentalCups } from './data/copas.ts';
import { getMatchCenter } from './data/espn.ts';
import { createCopaDoBrasilCup } from './copaDoBrasil.ts';
import { libertadoresCup } from './libertadores.ts';
import { createSulamericanaCup } from './sulamericana.ts';
import { computeEvolution, computeStandings, currentMatchday, isFinished, teamsFrom, type StandingRow } from './model/standings.ts';
import { LIST_METRICS, METRICS, POSITION_METRICS, ScoutIndex } from './model/scout.ts';
import { ratings, splitStats, streaks, teamResults, type Ratings } from './model/teamProfile.ts';
import type { Match, PlayerStats, Position, Team } from './types.ts';

const provider = config.footballDataToken
  ? createFootballDataProvider({
      token: config.footballDataToken,
      competition: config.competition,
      season: config.season,
    })
  : createMockProvider();

const playerProvider = config.apiFootballKey
  ? createApiFootballPlayerProvider({
      key: config.apiFootballKey,
      league: config.apiFootballLeague,
      season: config.apiFootballSeason,
    })
  : createMockPlayerProvider();

interface Analysis {
  matches: Match[];
  teams: Team[];
  standings: StandingRow[];
  model: FittedModel;
  ratings: Map<number, Ratings>;
  outlook: Map<number, TeamOutlook>;
  zones: ZoneOutlook;
  /** Copas que dão vaga extra (null: vale só a tabela) */
  cups: ContinentalCups | null;
  /** Copas que entraram nas vagas pela simulação da própria aba */
  cupSources: CupSources | null;
  /** Histórico de acertos de cada modelo (para comparar) */
  history: Record<ModelKind, BacktestResult>;
  calibration: CalibrationState;
  background: BackgroundState;
  /** Histórico do Dixon-Coles sem as temporadas anteriores (para mostrar quanto elas ajudam) */
  historyWithoutBackground: BacktestResult | null;
  currentMatchday: number;
  totalMatchdays: number;
  updatedAt: string;
}

let lastAnalysis: { key: string; value: Analysis } | null = null;
let lastHistory: { key: string; value: HistorySet } | null = null;

interface HistorySet {
  byModel: Record<ModelKind, BacktestResult>;
  withoutBackground: BacktestResult | null;
}

/** Identifica o conjunto de jogos encerrados (o histórico e a calibração só dependem dele). */
const finishedKey = (matches: Match[]) =>
  matches
    .filter(isFinished)
    .map((m) => `${m.id}:${m.homeGoals}-${m.awayGoals}`)
    .join('|');

// ---------- Temporadas anteriores ----------

interface BackgroundState {
  background: Background | null;
  error: string | null;
  loadedAt: number;
}

let backgroundState: Promise<BackgroundState> | null = null;
/** Se a busca falhar, tenta de novo depois desse tempo */
const BACKGROUND_RETRY_MS = 30 * 60_000;

/** Temporadas anteriores: não mudam, então busca uma vez só (ou de novo, se deu erro). */
async function getBackground(teams: Team[]): Promise<BackgroundState> {
  if (config.previousSeasons <= 0) return { background: null, error: null, loadedAt: 0 };
  if (backgroundState) {
    const current = await backgroundState;
    if (!current.error || Date.now() - current.loadedAt < BACKGROUND_RETRY_MS) return current;
  }
  backgroundState = provider
    .getPreviousSeasons(config.previousSeasons)
    .then((seasons) => {
      const background = buildBackground(teams, seasons);
      console.log(
        background
          ? `   Temporadas anteriores: ${background.seasons.join(', ')} (${background.matches.length} jogos; subiram: ${background.newTeams.map((t) => t.shortName).join(', ') || 'nenhum'})`
          : '   Temporadas anteriores: nenhum jogo encontrado',
      );
      return { background, error: null, loadedAt: Date.now() };
    })
    .catch((err: Error) => {
      console.log(`   Temporadas anteriores: não foi possível carregar (${err.message})`);
      return { background: null, error: err.message, loadedAt: Date.now() };
    });
  return backgroundState;
}

const backgroundKey = (bg: Background | null) => (bg ? bg.seasons.join(',') : '-');

// ---------- Calibração do TIME_DECAY ----------

type CalibrationState =
  | { status: 'fixed'; decay: number }
  | { status: 'too-few'; decay: number; matches: number }
  | { status: 'running'; decay: number }
  | { status: 'done'; decay: number; result: Calibration }
  | { status: 'error'; decay: number; error: string };

let calibration: { key: string; state: CalibrationState } | null = null;

/**
 * Decaimento em uso agora. Quando entram resultados novos, recalibra em segundo
 * plano e, enquanto isso, continua usando o último valor calibrado.
 */
function currentCalibration(teams: Team[], matches: Match[], background: Background | null): CalibrationState {
  if (config.timeDecay !== 'auto') return { status: 'fixed', decay: config.timeDecay };

  const key = `${finishedKey(matches)}|${backgroundKey(background)}`;
  if (calibration?.key === key) return calibration.state;

  const finished = matches.filter(isFinished).length;
  if (finished < MIN_MATCHES) {
    calibration = { key, state: { status: 'too-few', decay: config.defaultTimeDecay, matches: finished } };
    return calibration.state;
  }

  const previous = calibration?.state.status === 'done' ? calibration.state.decay : config.defaultTimeDecay;
  const entry: { key: string; state: CalibrationState } = { key, state: { status: 'running', decay: previous } };
  calibration = entry;
  console.log('   Calibrando TIME_DECAY…');
  calibrateTimeDecay(teams, matches, config.defaultTimeDecay, background)
    .then((result) => {
      if (calibration !== entry) return; // chegaram resultados novos no meio do caminho
      entry.state = { status: 'done', decay: result.best, result };
      console.log(
        result.outcome === 'better'
          ? `   TIME_DECAY calibrado: ${result.best} (meia-vida de ${halfLife(result.best) ?? '∞'} dias)`
          : `   TIME_DECAY: nenhum valor foi claramente melhor; mantido o padrão ${result.best}`,
      );
      // Refaz modelo, simulação e histórico com o valor calibrado
      lastAnalysis = null;
      lastHistory = null;
    })
    .catch((err: Error) => {
      if (calibration === entry) entry.state = { status: 'error', decay: previous, error: err.message };
    });
  return entry.state;
}

/** O histórico só depende dos jogos encerrados: não precisa refazer a cada minuto de jogo ao vivo. */
function getHistory(teams: Team[], matches: Match[], calib: CalibrationState, background: Background | null): HistorySet {
  const key = `${finishedKey(matches)}@${calib.decay}|${backgroundKey(background)}`;
  if (lastHistory?.key !== key) {
    const byModel = Object.fromEntries(
      MODEL_KINDS.map((kind) => {
        // A calibração já calculou o histórico do valor escolhido: reaproveita
        if (kind === 'dixon-coles' && calib.status === 'done' && calib.result.best === calib.decay) {
          return [kind, calib.result.bestResult];
        }
        return [kind, backtest(kind, teams, matches, calib.decay, background)];
      }),
    ) as Record<ModelKind, BacktestResult>;
    const withoutBackground = background ? backtest('dixon-coles', teams, matches, calib.decay) : null;
    lastHistory = { key, value: { byModel, withoutBackground } };
  }
  return lastHistory.value;
}

/** Resumo das temporadas anteriores para a tela. */
function backgroundInfo(a: Analysis) {
  const bg = a.background.background;
  return {
    enabled: config.previousSeasons > 0 && config.model === 'dixon-coles',
    seasons: bg?.seasons ?? [],
    matches: bg?.matches.length ?? 0,
    newTeams: bg?.newTeams.map((t) => t.shortName) ?? [],
    error: a.background.error,
  };
}

/** Nota Brier e acerto só das primeiras rodadas (onde a temporada anterior mais ajuda). */
function earlyRounds(result: BacktestResult, lastRound: number) {
  const entries = result.entries.filter((e) => e.match.matchday <= lastRound);
  if (!entries.length) return null;
  return {
    brier: entries.reduce((sum, e) => sum + e.brier, 0) / entries.length,
    accuracy: entries.filter((e) => e.hit).length / entries.length,
    matches: entries.length,
  };
}
const EARLY_ROUNDS = 10;

/** Nome do modelo para a tela, com a meia-vida quando é Dixon-Coles. */
function modelLabel(calib: CalibrationState): string {
  if (config.model !== 'dixon-coles') return MODEL_LABELS[config.model];
  const days = halfLife(calib.decay);
  return `${MODEL_LABELS['dixon-coles']} (${days ? `meia-vida de ${days} dias` : 'sem decaimento'})`;
}

/** As copas de 2026 só valem para o Brasileirão real de 2026. */
function cupsApply(matches: Match[]): boolean {
  const season = Math.min(...matches.map((m) => new Date(m.utcDate).getUTCFullYear()));
  return provider.name === 'football-data.org' && config.competition === 'BSA' && season === 2026;
}

const cupYear = Number(config.season) || new Date().getUTCFullYear();
const leagueTeams = async () => teamsFrom(await provider.getMatches());
const copaDoBrasilCup = createCopaDoBrasilCup({ year: cupYear, leagueMatches: () => provider.getMatches(), leagueTeams });
const sulamericanaCup = createSulamericanaCup({
  year: cupYear,
  extraMatches: async () => [...(await provider.getMatches()), ...(await libertadoresCup.matches().catch(() => [] as Match[]))],
  leagueTeams,
});

/** Quais copas entram nas vagas com a simulação da própria aba (as outras, pelo copas.ts) */
export interface CupSources {
  libertadores: boolean;
  copaDoBrasil: boolean;
  sulamericana: boolean;
}

/**
 * Situação das copas para as vagas. Cada copa usa a mesma simulação da sua aba
 * (chaveamento real e modelo próprio); se alguma falhar, ela volta para as
 * semifinais escritas à mão em copas.ts.
 */
async function currentCups(teams: Team[]): Promise<{ cups: ContinentalCups; sources: CupSources; key: string }> {
  const ids = new Set(teams.map((t) => t.id));
  const cups = { ...CUPS_2026 };
  const sources: CupSources = { libertadores: false, copaDoBrasil: false, sulamericana: false };
  const keys: string[] = [];
  try {
    const lib = await libertadoresCup.outcomes(ids);
    cups.libertadores = { ...cups.libertadores, odds: lib.odds };
    sources.libertadores = true;
    keys.push(lib.updatedAt);
  } catch (err) {
    console.warn('Vagas: sem a simulação da Libertadores, usando as semifinais de copas.ts:', (err as Error).message);
  }
  try {
    // Campeão e vice da Copa do Brasil vão à Libertadores: cada desfecho é uma final
    const cdb = await copaDoBrasilCup.outcomes(ids, true);
    if (cdb.odds.length) {
      cups.copaDoBrasil = { ...cups.copaDoBrasil, odds: cdb.odds };
      sources.copaDoBrasil = true;
      keys.push(cdb.updatedAt);
    }
  } catch (err) {
    console.warn('Vagas: sem a simulação da Copa do Brasil, usando as semifinais de copas.ts:', (err as Error).message);
  }
  try {
    // Só o campeão da Sul-Americana ganha vaga (e só se for brasileiro)
    const sula = await sulamericanaCup.outcomes(ids);
    if (sula.odds.length) {
      cups.sulamericana = { ...cups.sulamericana, odds: sula.odds };
      sources.sulamericana = true;
      keys.push(sula.updatedAt);
    }
  } catch (err) {
    console.warn('Vagas: sem a simulação da Sul-Americana, usando as semifinais de copas.ts:', (err as Error).message);
  }
  return { cups, sources, key: keys.join('+') || 'manual' };
}

function runSimulation(
  teams: Team[],
  matches: Match[],
  model: FittedModel,
  cups: ContinentalCups | null,
  runs: number,
  seed = Date.now(),
  forced?: Map<number, [number, number]>,
) {
  return simulateSeason(teams, matches, model, {
    runs,
    zones: config.zones,
    rng: mulberry32(seed),
    forced,
    cups: cups ? createCupSimulator(model, teams.map((t) => t.id), cups) : undefined,
  });
}

/** Recalcula tabela, modelo e simulação só quando algum placar muda. */
async function getAnalysis(): Promise<Analysis> {
  const matches = await provider.getMatches();
  const teams = teamsFrom(matches);
  // A Libertadores entra na chave: quando a chance de título muda, as vagas mudam junto
  const cupState = cupsApply(matches) ? await currentCups(teams) : null;
  const key =
    matches.map((m) => `${m.id}:${m.status}:${m.homeGoals}-${m.awayGoals}:${m.minute ?? ''}`).join('|') + `#${cupState?.key ?? ''}`;
  if (lastAnalysis?.key === key) return lastAnalysis.value;

  const bg = await getBackground(teams);
  const calib = currentCalibration(teams, matches, bg.background);
  const model = fitModel(config.model, teams, matches, new Date().toISOString(), calib.decay, bg.background);
  const history = getHistory(teams, matches, calib, bg.background);
  const cups = cupState?.cups ?? null;
  const outlook = runSimulation(teams, matches, model, cups, config.simulations);
  const matchdays = matches.map((m) => m.matchday);

  const value: Analysis = {
    matches,
    teams,
    standings: computeStandings(teams, matches),
    model,
    ratings: ratings(model, teams),
    outlook: new Map(outlook.teams.map((o) => [o.teamId, o])),
    zones: outlook.zones,
    cups,
    cupSources: cupState?.sources ?? null,
    history: history.byModel,
    historyWithoutBackground: history.withoutBackground,
    calibration: calib,
    background: bg,
    currentMatchday: currentMatchday(matches),
    totalMatchdays: Math.max(...matchdays),
    updatedAt: new Date().toISOString(),
  };
  lastAnalysis = { key, value };
  return value;
}

const app = express();
// "no-cache": o navegador (principalmente o do celular) sempre confere se há versão
// nova da página, do CSS e do JS antes de usar a cópia guardada
app.use(express.static(path.join(import.meta.dirname, '..', 'public'), { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

const route = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch(next);

app.get(
  '/api/overview',
  route(async (_req, res) => {
    const a = await getAnalysis();
    res.json({
      source: provider.name,
      model: modelLabel(a.calibration),
      background: backgroundInfo(a),
      updatedAt: a.updatedAt,
      simulations: config.simulations,
      zones: a.zones.likely,
      zoneOutlook: { ...a.zones, withCups: !!a.cups, cupSources: a.cupSources },
      currentMatchday: a.currentMatchday,
      totalMatchdays: a.totalMatchdays,
      standings: a.standings.map((row) => ({ ...row, outlook: a.outlook.get(row.team.id) })),
    });
  }),
);

app.get(
  '/api/matches',
  route(async (req, res) => {
    const a = await getAnalysis();
    const matchday = Number(req.query.matchday) || a.currentMatchday;
    const matches = a.matches
      .filter((m) => m.matchday === matchday)
      .sort((x, y) => x.utcDate.localeCompare(y.utcDate))
      .map((m) => ({ ...m, prediction: isFinished(m) ? null : predictMatch(a.model, m) }));
    res.json({
      matchday,
      currentMatchday: a.currentMatchday,
      totalMatchdays: a.totalMatchdays,
      watchUrl: config.watchUrl,
      matches,
    });
  }),
);

// ---------- Simulador "e se" ----------

const WHATIF_RUNS = 4000;
// Mesma sequência de sorteios no cenário-base e no "e se": a diferença entre os
// dois vem só dos palpites, não do acaso da simulação.
const WHATIF_SEED = 2026;
let whatifBase: { analysis: Analysis; teams: TeamOutlook[] } | null = null;

function whatifBaseline(a: Analysis): TeamOutlook[] {
  if (whatifBase?.analysis !== a) {
    whatifBase = { analysis: a, teams: runSimulation(a.teams, a.matches, a.model, a.cups, WHATIF_RUNS, WHATIF_SEED).teams };
  }
  return whatifBase.teams;
}
app.get(
  '/api/whatif',
  route(async (_req, res) => {
    const a = await getAnalysis();
    const pending = a.matches
      .filter((m) => !isFinished(m))
      .sort((x, y) => x.matchday - y.matchday || x.utcDate.localeCompare(y.utcDate))
      .map((m) => ({ ...m, prediction: predictMatch(a.model, m) }));
    res.json({
      currentMatchday: a.currentMatchday,
      totalMatchdays: a.totalMatchdays,
      matches: pending,
      standings: a.standings.map((row) => ({ position: row.position, team: row.team, points: row.points, outlook: a.outlook.get(row.team.id) })),
    });
  }),
);

app.post(
  '/api/whatif',
  express.json({ limit: '16kb' }),
  route(async (req, res) => {
    const a = await getAnalysis();
    const forced = pickedScores(a.matches, req.body?.picks ?? {});
    // O modelo (força dos times) fica o mesmo: só os resultados escolhidos mudam
    const outlook = runSimulation(a.teams, a.matches, a.model, a.cups, WHATIF_RUNS, WHATIF_SEED, forced);
    res.json({ runs: WHATIF_RUNS, teams: outlook.teams, base: whatifBaseline(a), zones: outlook.zones.likely });
  }),
);

// ---------- Página do jogo ----------

const stakesCache = new Map<string, Record<Pick, TeamOutlook[]>>();

/** Como ficam as chances de todos se o jogo terminar em vitória do mandante, empate ou vitória do visitante. */
function matchStakes(a: Analysis, m: Match): Record<Pick, TeamOutlook[]> {
  const key = `${a.updatedAt}:${m.id}`;
  let value = stakesCache.get(key);
  if (!value) {
    value = {} as Record<Pick, TeamOutlook[]>;
    for (const pick of ['H', 'D', 'A'] as Pick[]) {
      const r = applyPick(m, pick);
      const forced = new Map([[m.id, [r.homeGoals!, r.awayGoals!] as [number, number]]]);
      value[pick] = runSimulation(a.teams, a.matches, a.model, a.cups, WHATIF_RUNS, WHATIF_SEED, forced).teams;
    }
    if (stakesCache.size > 50) stakesCache.clear();
    stakesCache.set(key, value);
  }
  return value;
}

app.get(
  '/api/jogo/:id',
  route(async (req, res) => {
    const a = await getAnalysis();
    const m = a.matches.find((x) => x.id === Number(req.params.id));
    if (!m) {
      res.status(404).json({ error: 'Jogo não encontrado' });
      return;
    }
    const finished = isFinished(m);
    const side = (team: Team) => ({
      standing: a.standings.find((r) => r.team.id === team.id),
      outlook: a.outlook.get(team.id),
      // Últimos 5 jogos antes deste, do mais recente para o mais antigo
      last: teamResults(team.id, a.matches)
        .filter((r) => r.match.utcDate < m.utcDate)
        .slice(-5)
        .reverse()
        .map((r) => ({ date: r.match.utcDate, opponent: r.opponent, home: r.home, goalsFor: r.goalsFor, goalsAgainst: r.goalsAgainst, result: r.result })),
    });

    let stakes = null;
    if (!finished) {
      const s = matchStakes(a, m);
      const pick = (outlooks: TeamOutlook[]) => ({
        home: outlooks.find((o) => o.teamId === m.home.id),
        away: outlooks.find((o) => o.teamId === m.away.id),
      });
      stakes = { base: pick(whatifBaseline(a)), H: pick(s.H), D: pick(s.D), A: pick(s.A) };
    }

    // A ESPN é opcional: se falhar, a página mostra o resto
    let espn = null;
    let espnError: string | null = null;
    try {
      espn = await getMatchCenter(m);
    } catch (err) {
      espnError = (err as Error).message;
    }

    res.json({
      match: { ...m, prediction: finished ? null : predictMatch(a.model, m) },
      currentMatchday: a.currentMatchday,
      home: side(m.home),
      away: side(m.away),
      topScores: finished ? null : topScores(a.model, m),
      stakes,
      standings: a.standings.map((r) => ({ position: r.position, team: r.team, played: r.played, points: r.points, goalDiff: r.goalDiff })),
      zones: a.zones.likely,
      espn,
      espnError,
    });
  }),
);

app.get(
  '/api/evolution',
  route(async (_req, res) => {
    const a = await getAnalysis();
    const { matchdays, positions } = computeEvolution(a.teams, a.matches);
    res.json({
      matchdays,
      teams: a.standings.map((row) => ({ team: row.team, positions: positions.get(row.team.id) })),
    });
  }),
);

app.get(
  '/api/teams/:id',
  route(async (req, res) => {
    const a = await getAnalysis();
    const id = Number(req.params.id);
    const standing = a.standings.find((row) => row.team.id === id);
    if (!standing) {
      res.status(404).json({ error: 'Time não encontrado' });
      return;
    }

    const results = teamResults(id, a.matches);
    const { matchdays, positions } = computeEvolution(a.teams, a.matches);
    const upcoming = a.matches
      .filter((m) => !isFinished(m) && (m.home.id === id || m.away.id === id))
      .sort((x, y) => x.utcDate.localeCompare(y.utcDate))
      .slice(0, 5)
      .map((m) => ({ ...m, prediction: predictMatch(a.model, m) }));

    // Ranking da liga em ataque (mais gols esperados = 1º) e defesa (menos gols sofridos = 1º)
    const all = [...a.ratings.values()];
    const own = a.ratings.get(id)!;

    res.json({
      team: standing.team,
      standing,
      totalTeams: a.teams.length,
      zones: a.zones.likely,
      outlook: a.outlook.get(id),
      model: modelLabel(a.calibration),
      ratings: {
        ...own,
        attackRank: all.filter((r) => r.attack > own.attack).length + 1,
        defenseRank: all.filter((r) => r.defense < own.defense).length + 1,
      },
      home: splitStats(results.filter((r) => r.home)),
      away: splitStats(results.filter((r) => !r.home)),
      streaks: streaks(results),
      evolution: { matchdays, positions: positions.get(id) },
      results: results.reverse(),
      upcoming,
      watchUrl: config.watchUrl,
    });
  }),
);

// ---------- Scout de jogadores ----------

const POSITIONS: Position[] = ['Goleiro', 'Defensor', 'Meio-campista', 'Atacante'];
let scoutIndex: { players: PlayerStats[]; value: ScoutIndex } | null = null;

/** Índice do scout, ou null enquanto os jogadores ainda estão carregando. */
async function getScout(): Promise<ScoutIndex | null> {
  const loading = playerProvider.getPlayers();
  if (!playerProvider.status().ready) {
    loading.catch(() => {}); // o erro aparece em status().error
    return null;
  }
  const players = await loading;
  if (scoutIndex?.players !== players) scoutIndex = { players, value: new ScoutIndex(players, config.scoutMinMinutes) };
  return scoutIndex.value;
}

function scoutStatus() {
  return { source: playerProvider.name, minMinutes: config.scoutMinMinutes, ...playerProvider.status() };
}

const normalize = (s: string) =>
  s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Os times do scout vêm de outra API: acha o time correspondente da tabela pelo nome. */
function findMatchTeam(teams: Team[], name: string): number | null {
  const target = normalize(name);
  const found = teams.find((t) => {
    const names = [normalize(t.name), normalize(t.shortName)];
    return names.some((n) => n === target || (n.length >= 4 && target.length >= 4 && (n.includes(target) || target.includes(n))));
  });
  return found?.id ?? null;
}

const playerSummary = (p: PlayerStats) => ({
  id: p.id,
  name: p.name,
  photo: p.photo,
  age: p.age,
  team: p.team,
  position: p.position,
  minutes: p.minutes,
  appearances: p.appearances,
});

app.get(
  '/api/players',
  route(async (req, res) => {
    const scout = await getScout();
    if (!scout) {
      res.status(202).json({ status: scoutStatus() });
      return;
    }

    const position = POSITIONS.includes(req.query.position as Position) ? (req.query.position as Position) : null;
    const team = String(req.query.team ?? '');
    const q = normalize(String(req.query.q ?? ''));
    const minMinutes = Number(req.query.minMinutes ?? config.scoutMinMinutes) || 0;
    const columns = LIST_METRICS[position ?? 'all'];
    const sort = String(req.query.sort ?? columns[0]);
    const asc = req.query.dir === 'asc';

    const rows = scout.players
      .filter((p) => (!position || p.position === position) && (!team || p.team.name === team) && p.minutes >= minMinutes)
      .filter((p) => !q || normalize(p.name).includes(q))
      .map((p) => ({ ...playerSummary(p), metrics: scout.metrics(p, columns) }));

    const sortValue = (r: (typeof rows)[number]): number | string => {
      if (sort === 'name') return r.name;
      if (sort === 'minutes') return r.minutes;
      if (sort === 'age') return r.age ?? 0;
      return r.metrics.find((m) => m.key === sort)?.value ?? -Infinity;
    };
    rows.sort((a, b) => {
      const x = sortValue(a);
      const y = sortValue(b);
      const cmp = typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number);
      return asc ? cmp : -cmp;
    });

    res.json({
      status: scoutStatus(),
      columns: columns.map((key) => ({ key, label: METRICS[key].short, format: METRICS[key].format })),
      teams: [...new Set(scout.players.map((p) => p.team.name))].sort((a, b) => a.localeCompare(b)),
      positions: POSITIONS,
      total: rows.length,
      players: rows.slice(0, 100),
    });
  }),
);

app.get(
  '/api/players/:id',
  route(async (req, res) => {
    const scout = await getScout();
    if (!scout) {
      res.status(202).json({ status: scoutStatus() });
      return;
    }
    const player = scout.get(Number(req.params.id));
    if (!player) {
      res.status(404).json({ error: 'Jogador não encontrado' });
      return;
    }

    const keys = POSITION_METRICS[player.position];
    // Comparação só faz sentido entre jogadores da mesma posição (os percentis são por posição)
    const other = scout.get(Number(req.query.vs));
    const compare = other && other.id !== player.id && other.position === player.position ? other : null;
    const { teams } = await getAnalysis();

    res.json({
      status: scoutStatus(),
      player: { ...player, matchTeamId: findMatchTeam(teams, player.team.name) },
      poolSize: scout.poolSize(player.position),
      belowMinimum: player.minutes < scout.minMinutes,
      metrics: scout.metrics(player, keys),
      compare: compare ? { player: playerSummary(compare), metrics: scout.metrics(compare, keys) } : null,
      similar: scout.similar(player).map((s) => ({ ...playerSummary(s.player), similarity: s.similarity })),
      // Para o seletor de comparação
      samePosition: scout.players
        .filter((p) => p.position === player.position && p.id !== player.id)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => ({ id: p.id, name: p.name, team: p.team.name })),
    });
  }),
);

app.get(
  '/api/history',
  route(async (req, res) => {
    const a = await getAnalysis();
    const history = a.history;
    const { summary, entries } = history[config.model];
    const calib = a.calibration;
    const lastPlayed = summary.byMatchday.at(-1)?.matchday ?? 0;
    const matchday = Number(req.query.matchday) || lastPlayed;
    res.json({
      summary,
      model: modelLabel(a.calibration),
      comparison: [
        ...MODEL_KINDS.map((kind) => {
          const s = history[kind].summary;
          return {
            kind,
            label: MODEL_LABELS[kind] + (kind === 'dixon-coles' && a.historyWithoutBackground ? ' + temporada anterior' : ''),
            active: kind === config.model,
            accuracy: s.accuracy,
            exactAccuracy: s.exactAccuracy,
            brier: s.brier,
          };
        }),
        ...(a.historyWithoutBackground
          ? [
              {
                kind: 'dixon-coles-only-current',
                label: 'Dixon-Coles só com a temporada atual',
                active: false,
                accuracy: a.historyWithoutBackground.summary.accuracy,
                exactAccuracy: a.historyWithoutBackground.summary.exactAccuracy,
                brier: a.historyWithoutBackground.summary.brier,
              },
            ]
          : []),
      ],
      background: {
        ...backgroundInfo(a),
        earlyRounds: EARLY_ROUNDS,
        early: a.historyWithoutBackground
          ? { with: earlyRounds(history['dixon-coles'], EARLY_ROUNDS), without: earlyRounds(a.historyWithoutBackground, EARLY_ROUNDS) }
          : null,
      },
      calibration: {
        status: calib.status,
        decay: calib.decay,
        halfLifeDays: halfLife(calib.decay),
        minMatches: MIN_MATCHES,
        matches: a.matches.filter(isFinished).length,
        points: calib.status === 'done' ? calib.result.points : null,
        outcome: calib.status === 'done' ? calib.result.outcome : null,
        atEdge: calib.status === 'done' ? calib.result.atEdge : false,
        defaultDecay: config.defaultTimeDecay,
        error: calib.status === 'error' ? calib.error : null,
      },
      matchday,
      firstMatchday: summary.byMatchday[0]?.matchday ?? 0,
      lastMatchday: lastPlayed,
      entries: entries.filter((e) => e.match.matchday === matchday),
    });
  }),
);

app.get(
  '/api/scorers',
  route(async (_req, res) => {
    res.json({ source: provider.name, scorers: await provider.getScorers() });
  }),
);

app.use('/api/lib', libertadoresCup.router);
app.use('/api/cdb', copaDoBrasilCup.router);
app.use('/api/sula', sulamericanaCup.router);

// ---------- Ao vivo: avisa as páginas abertas assim que um placar muda ----------

const streams = new Set<Response>();

function broadcast(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of streams) res.write(msg);
}

app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  streams.add(res);
  // Comentário a cada 25 s para a conexão não cair por inatividade (proxies, celular)
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    streams.delete(res);
  });
});

let lastMatches: Match[] | null = null;

/** Lê os placares de tempos em tempos e manda gols, inícios e fins de jogo para as páginas. */
async function watchLive() {
  let delay = 60_000;
  try {
    const matches = await provider.getMatches();
    if (lastMatches) {
      const events = liveEvents(lastMatches, matches);
      const changed = matches.some((m, i) => {
        const o = lastMatches![i];
        return !o || o.id !== m.id || o.status !== m.status || o.homeGoals !== m.homeGoals || o.awayGoals !== m.awayGoals || o.minute !== m.minute;
      });
      if (changed) broadcast('update', { events });
    }
    lastMatches = matches;
    if (isMatchTime(matches)) delay = 15_000;
  } catch (err) {
    console.error('Falha ao atualizar os placares:', (err as Error).message);
  }
  setTimeout(watchLive, delay);
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(502).json({ error: err.message });
});

app.listen(config.port, () => {
  console.log(`⚽ Dashboard rodando em http://localhost:${config.port}`);
  console.log(`   Fonte de dados: ${provider.name} · modelo: ${MODEL_LABELS[config.model]}`);
  getAnalysis().catch(() => {}); // já começa a calcular (e a calibrar) sem esperar a primeira visita
  watchLive();
  if (!config.footballDataToken) console.log('   (crie um arquivo .env com FOOTBALL_DATA_TOKEN para usar dados reais)');
});
