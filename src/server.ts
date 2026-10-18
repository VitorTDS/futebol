import compression from 'compression';
import express, { type NextFunction, type Request, type Response } from 'express';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.ts';
import { createFootballDataProvider } from './data/footballData.ts';
import { createMockProvider } from './data/mock.ts';
import { resilient } from './data/resilient.ts';
import { createApiFootballPlayerProvider } from './data/players/apiFootball.ts';
import { createMockPlayerProvider } from './data/players/mock.ts';
import type { BacktestResult } from './model/backtest.ts';
import { halfLife, MIN_MATCHES, type Calibration } from './model/calibration.ts';
import { calibrateOffThread, chancesOffThread, historyOffThread } from './model/offThread.ts';
import { buildBackground, fitModel, MODEL_KINDS, type Background } from './model/models.ts';
import { MODEL_LABELS, predictMatch, topScores, type FittedModel, type ModelKind } from './model/prediction.ts';
import { mulberry32 } from './model/random.ts';
import { createCupSimulator } from './model/cups.ts';
import { isMatchTime, liveEvents, type LiveEvent } from './model/liveEvents.ts';
import { applyPick, pickedScores, type Pick } from './model/whatif.ts';
import { simulateSeason, type TeamOutlook, type ZoneOutlook } from './model/simulation.ts';
import { CUPS_2026, type ContinentalCups, type Cup } from './data/copas.ts';
import { getMatchCenter, getTeamColors } from './data/espn.ts';
import { createCopaDoBrasilCup } from './copaDoBrasil.ts';
import { libertadoresCup } from './libertadores.ts';
import { compareFinished, compareUpcoming, loadFinishedOdds, marketProgress } from './market.ts';
import { push, pushEvents, pushMessage } from './push.ts';
import { createSerieB } from './serieB.ts';
import { createSulamericanaCup } from './sulamericana.ts';
import { computeEvolution, computeStandings, currentMatchday, isFinished, teamsFrom, type StandingRow } from './model/standings.ts';
import { LIST_METRICS, METRICS, POSITION_METRICS, ScoutIndex } from './model/scout.ts';
import { ratings, splitStats, streaks, teamResults, type Ratings } from './model/teamProfile.ts';
import type { Match, PlayerStats, Position, Team } from './types.ts';

// Se a fonte cair, segue com os últimos placares (e o painel avisa)
const provider = resilient(
  config.footballDataToken
    ? createFootballDataProvider({
        token: config.footballDataToken,
        competition: config.competition,
        season: config.season,
      })
    : createMockProvider(),
  'Brasileirão',
);

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
  calibration: CalibrationState;
  background: BackgroundState;
  currentMatchday: number;
  totalMatchdays: number;
  updatedAt: string;
}

let lastAnalysis: { key: string; value: Analysis } | null = null;
let lastHistory: { key: string; value: Promise<HistorySet> } | null = null;

interface HistorySet {
  /** Histórico de acertos de cada modelo (para comparar) */
  byModel: Record<ModelKind, BacktestResult>;
  /** Histórico do Dixon-Coles sem as temporadas anteriores (para mostrar quanto elas ajudam) */
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
  calibrateOffThread({ teams, matches, defaultDecay: config.defaultTimeDecay, background })
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

/**
 * O histórico só depende dos jogos encerrados: não precisa refazer a cada minuto
 * de jogo ao vivo. São vários backtests (segundos de conta), então rodam na thread
 * de backtests e só quando a aba Acertos pede.
 */
function getHistory(teams: Team[], matches: Match[], calib: CalibrationState, background: Background | null): Promise<HistorySet> {
  const key = `${finishedKey(matches)}@${calib.decay}|${backgroundKey(background)}`;
  if (lastHistory?.key !== key) {
    // A calibração já calculou o histórico do Dixon-Coles com o valor escolhido: reaproveita
    const ready = calib.status === 'done' && calib.result.best === calib.decay ? calib.result.bestResult : null;
    const entry = {
      key,
      value: historyOffThread({ teams, matches, decay: calib.decay, background, skip: ready ? ['dixon-coles'] : [] }).then(
        (r): HistorySet => ({
          byModel: { ...r.byModel, ...(ready ? { 'dixon-coles': ready } : {}) } as Record<ModelKind, BacktestResult>,
          withoutBackground: r.withoutBackground,
        }),
      ),
    };
    // Se der erro, tenta de novo na próxima vez
    entry.value.catch(() => lastHistory === entry && (lastHistory = null));
    lastHistory = entry;
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
// A página do time da Série B mostra também a Copa do Brasil (os ids da ESPN batem)
const serieB = createSerieB({ year: cupYear, cups: [(id) => copaDoBrasilCup.teamSummary(id)] });
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
  // As três ao mesmo tempo (cada uma busca a sua fonte)
  const [lib, cdb, sula] = await Promise.allSettled([
    libertadoresCup.outcomes(ids),
    // Campeão e vice da Copa do Brasil vão à Libertadores: cada desfecho é uma final
    copaDoBrasilCup.outcomes(ids, true),
    // Só o campeão da Sul-Americana ganha vaga (e só se for brasileiro)
    sulamericanaCup.outcomes(ids),
  ]);
  const use = (r: PromiseSettledResult<{ key: string; odds: Cup['odds'] & {} }>, cup: keyof ContinentalCups, label: string) => {
    if (r.status === 'fulfilled' && r.value.odds.length) {
      cups[cup] = { ...cups[cup], odds: r.value.odds };
      sources[cup] = true;
      keys.push(r.value.key);
    } else if (r.status === 'rejected') {
      console.warn(`Vagas: sem a simulação da ${label}, usando as semifinais de copas.ts:`, (r.reason as Error).message);
    }
  };
  use(lib, 'libertadores', 'Libertadores');
  use(cdb, 'copaDoBrasil', 'Copa do Brasil');
  use(sula, 'sulamericana', 'Sul-Americana');
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
// Respostas comprimidas (gzip): a página e os dados chegam bem menores no 4G
app.use(compression());

// Código da página: os arquivos de public/js juntos, nesta ordem, num download só
const PAGE_SCRIPTS = ['base', 'classificacao', 'destaque', 'jogos', 'evolucao', 'acertos', 'time', 'scout', 'artilharia', 'jogo', 'agenda', 'serieb', 'copas', 'ese', 'compartilhar', 'alertas', 'navegacao', 'aovivo'];
const PUBLIC_DIR = path.join(import.meta.dirname, '..', 'public');
let pageBundle: Promise<string> | null = null;
function buildBundle() {
  return Promise.all(PAGE_SCRIPTS.map((name) => readFile(path.join(PUBLIC_DIR, 'js', `${name}.js`), 'utf8'))).then((files) =>
    files.map((code, i) => `// ---------- js/${PAGE_SCRIPTS[i]}.js ----------\n${code}`).join('\n'),
  );
}
app.get('/app.js', (_req, res, next) => {
  // Em produção junta uma vez; no computador, a cada pedido (para ver as mudanças na hora)
  (process.env.NODE_ENV === 'production' ? (pageBundle ??= buildBundle()) : buildBundle())
    .then((code) => res.type('application/javascript').set('Cache-Control', 'no-cache').send(code))
    .catch(next);
});
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

/** Copas com os palpites do "e se" ({ lib: {...}, cdb: {...}, sula: {...} }) aplicados. */
async function cupsWithPicks(a: Analysis, cupPicks: unknown): Promise<ContinentalCups | null> {
  if (!a.cups || !cupPicks || typeof cupPicks !== 'object') return a.cups;
  const picks = cupPicks as Record<string, unknown>;
  const ids = new Set(a.teams.map((t) => t.id));
  const cups = { ...a.cups };
  const sources = [
    ['lib', libertadoresCup, 'libertadores', false],
    ['cdb', copaDoBrasilCup, 'copaDoBrasil', true],
    ['sula', sulamericanaCup, 'sulamericana', false],
  ] as const;
  await Promise.all(
    sources.map(async ([key, cup, field, withRunnerUp]) => {
      const p = picks[key];
      if (!p || typeof p !== 'object' || !Object.keys(p).length) return;
      const r = await cup.outcomes(ids, withRunnerUp, p).catch(() => null);
      if (r?.odds.length) cups[field] = { ...cups[field], odds: r.odds };
    }),
  );
  return cups;
}

app.post(
  '/api/whatif',
  express.json({ limit: '16kb' }),
  route(async (req, res) => {
    const a = await getAnalysis();
    const forced = pickedScores(a.matches, req.body?.picks ?? {});
    // Palpites nas copas (quem passa em cada confronto) mudam quem leva as vagas extras
    const cups = await cupsWithPicks(a, req.body?.cupPicks);
    // O modelo (força dos times) fica o mesmo: só os resultados escolhidos mudam
    const outlook = runSimulation(a.teams, a.matches, a.model, cups, WHATIF_RUNS, WHATIF_SEED, forced);
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
    // Cores dos clubes (da ESPN); sem elas, o gráfico usa cores genéricas
    const colors = await getTeamColors().catch(() => new Map<number, string>());
    res.json({
      matchdays,
      teams: a.standings.map((row) => ({ team: row.team, positions: positions.get(row.team.id), color: colors.get(row.team.id) ?? null })),
    });
  }),
);

// Chances rodada a rodada: o passado não muda, então só refaz quando sai resultado
let lastChances: { key: string; value: Promise<{ rounds: number[]; teams: { teamId: number; title: number[]; libertadores: number[]; relegation: number[] }[] }> } | null = null;
const CHANCES_RUNS = 3000;

function chancesByRound(a: Analysis) {
  const key = `${finishedKey(a.matches)}@${a.calibration.decay}|${backgroundKey(a.background.background)}`;
  if (lastChances?.key !== key) {
    const entry = {
      key,
      value: chancesOffThread({
        model: config.model,
        teams: a.teams,
        matches: a.matches,
        decay: a.calibration.decay,
        background: a.background.background,
        zones: config.zones,
        // Sem as copas: a situação delas mudou ao longo do ano, e usar a de hoje no
        // passado dá números enganosos. No histórico, a Libertadores é só pela tabela (G5)
        cups: null,
        runs: CHANCES_RUNS,
      }),
    };
    entry.value.catch(() => lastChances === entry && (lastChances = null));
    lastChances = entry;
  }
  return lastChances.value;
}

app.get(
  '/api/chances',
  route(async (_req, res) => {
    const a = await getAnalysis();
    const c = await chancesByRound(a);
    const byId = new Map(c.teams.map((t) => [t.teamId, t]));
    res.json({
      runs: CHANCES_RUNS,
      rounds: c.rounds,
      // Na ordem da tabela de hoje
      teams: a.standings.map((row) => ({ team: row.team, ...byId.get(row.team.id) })),
    });
  }),
);

// Modelo × casas de apostas
app.get(
  '/api/mercado',
  route(async (_req, res) => {
    const a = await getAnalysis();
    // Cotações dos jogos encerrados: a primeira vez busca em segundo plano (e a página mostra o andamento)
    loadFinishedOdds(a.matches);
    const h = await getHistory(a.teams, a.matches, a.calibration, a.background.background);
    const soon = Date.now() + 8 * 86_400_000;
    const upcoming = a.matches
      .filter((m) => !isFinished(m) && m.status !== 'LIVE' && Date.parse(m.utcDate) > Date.now() && Date.parse(m.utcDate) < soon)
      .slice(0, 20)
      .map((m) => ({ match: m, model: predictMatch(a.model, m) }));
    res.json({
      progress: marketProgress(),
      season: compareFinished(h.byModel[config.model].entries),
      upcoming: await compareUpcoming(upcoming),
    });
  }),
);

// Agenda: jogos de todos os campeonatos nos próximos dias (e os de hoje que já rolaram)
app.get(
  '/api/agenda',
  route(async (req, res) => {
    const days = Math.min(30, Math.max(1, Number(req.query.dias) || 7));
    // Desde o começo do dia no Brasil (UTC-3), para mostrar os jogos de hoje que já acabaram
    const now = Date.now();
    const from = now - ((now - 3 * 3_600_000) % 86_400_000);
    const to = from + days * 86_400_000;
    const a = await getAnalysis();
    const league = a.matches
      .filter((m) => Date.parse(m.utcDate) >= from && Date.parse(m.utcDate) <= to)
      .map((m) => ({ ...m, comp: 'bsa', stageLabel: `Rodada ${m.matchday}`, prediction: isFinished(m) ? null : predictMatch(a.model, m) }));
    const cups = await Promise.allSettled([libertadoresCup, copaDoBrasilCup, sulamericanaCup, serieB].map((c) => c.agenda(from, to)));
    const matches = [...league, ...cups.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))].sort((x, y) => x.utcDate.localeCompare(y.utcDate));
    res.json({ days, from: new Date(from).toISOString(), watchUrl: config.watchUrl, matches });
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
      // O mesmo time nas copas (só as que ele joga), para a página mostrar tudo junto
      cups: (await Promise.allSettled([libertadoresCup, copaDoBrasilCup, sulamericanaCup].map((c) => c.teamSummary(id))))
        .map((r) => (r.status === 'fulfilled' ? r.value : null))
        .filter((c) => c != null),
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
    const h = await getHistory(a.teams, a.matches, a.calibration, a.background.background);
    const history = h.byModel;
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
            label: MODEL_LABELS[kind] + (kind === 'dixon-coles' && h.withoutBackground ? ' + temporada anterior' : ''),
            active: kind === config.model,
            accuracy: s.accuracy,
            exactAccuracy: s.exactAccuracy,
            brier: s.brier,
          };
        }),
        ...(h.withoutBackground
          ? [
              {
                kind: 'dixon-coles-only-current',
                label: 'Dixon-Coles só com a temporada atual',
                active: false,
                accuracy: h.withoutBackground.summary.accuracy,
                exactAccuracy: h.withoutBackground.summary.exactAccuracy,
                brier: h.withoutBackground.summary.brier,
              },
            ]
          : []),
      ],
      background: {
        ...backgroundInfo(a),
        earlyRounds: EARLY_ROUNDS,
        early: h.withoutBackground
          ? { with: earlyRounds(history['dixon-coles'], EARLY_ROUNDS), without: earlyRounds(h.withoutBackground, EARLY_ROUNDS) }
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
app.use('/api/serieb', serieB.router);
app.use('/api/push', push);

// Situação de cada fonte, para a página avisar quando está mostrando placares antigos
app.get('/api/status', (_req, res) => {
  res.json({
    bsa: provider.health(),
    lib: libertadoresCup.health(),
    cdb: copaDoBrasilCup.health(),
    sula: sulamericanaCup.health(),
    serieb: serieB.health(),
  });
});

// Escudos pelo próprio servidor: a imagem de compartilhar é desenhada na página, e o
// navegador só deixa salvar o desenho se as imagens vierem do mesmo endereço (o
// servidor de escudos da football-data não libera). Só desses dois sites, e guardados em disco.
const CREST_HOSTS = new Set(['crests.football-data.org', 'a.espncdn.com']);
const CREST_DIR = path.join(import.meta.dirname, '..', 'data', 'cache', 'escudos');
app.get(
  '/api/escudo',
  route(async (req, res) => {
    let url: URL;
    try {
      url = new URL(String(req.query.u ?? ''));
    } catch {
      res.status(400).end();
      return;
    }
    if (url.protocol !== 'https:' || !CREST_HOSTS.has(url.hostname)) {
      res.status(400).end();
      return;
    }
    const file = path.join(CREST_DIR, `${url.hostname}${url.pathname}`.replace(/[^a-z0-9.]/gi, '_'));
    let body: Buffer;
    try {
      body = await readFile(file);
    } catch {
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) {
        res.status(r.status).end();
        return;
      }
      body = Buffer.from(await r.arrayBuffer());
      await mkdir(CREST_DIR, { recursive: true });
      await writeFile(file, body);
    }
    res.set({ 'Content-Type': url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png', 'Cache-Control': 'public, max-age=604800' });
    res.send(body);
  }),
);

// Botão "Assistir" de cada campeonato: link e nome do canal (para o botão dizer "no Premiere")
app.get('/api/assistir', (_req, res) => {
  const label = (url: string) => (url.includes('/canais/premiere') ? 'Premiere' : url.includes('globoplay') ? 'Globoplay' : null);
  res.json(
    Object.fromEntries(
      Object.entries(config.watch).map(([comp, url]) => {
        const u = url || config.watchUrl;
        return [comp, { url: u, label: label(u) }];
      }),
    ),
  );
});

// Para a hospedagem saber que o servidor está de pé (e para um "despertador" externo)
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

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

interface LiveSource {
  comp: string;
  name: string;
  getMatches: () => Promise<Match[]>;
  /** Intervalo com jogo rolando (a football-data grátis aceita 10 pedidos por minuto) */
  liveDelay: number;
  jogoUrl: (id: number) => string;
}

const LIVE_SOURCES: LiveSource[] = [
  { comp: 'bsa', name: 'Brasileirão', getMatches: () => provider.refreshMatches(), liveDelay: 15_000, jogoUrl: (id) => `/#/jogo/${id}` },
  { comp: 'lib', name: 'Libertadores', getMatches: libertadoresCup.liveMatches, liveDelay: 20_000, jogoUrl: (id) => `/#/lib/jogo/${id}` },
  { comp: 'cdb', name: 'Copa do Brasil', getMatches: copaDoBrasilCup.liveMatches, liveDelay: 30_000, jogoUrl: (id) => `/#/cdb/jogo/${id}` },
  { comp: 'sula', name: 'Sul-Americana', getMatches: sulamericanaCup.liveMatches, liveDelay: 30_000, jogoUrl: (id) => `/#/sula/jogo/${id}` },
  { comp: 'serieb', name: 'Série B', getMatches: serieB.liveMatches, liveDelay: 30_000, jogoUrl: (id) => `/#/serieb/jogo/${id}` },
];

const sameScore = (a: Match, b: Match) =>
  a.status === b.status && a.homeGoals === b.homeGoals && a.awayGoals === b.awayGoals && a.minute === b.minute;

// ---------- Avisos além do gol: lembrete, resumo do jogo e mudanças grandes ----------

const reminded = new Set<string>();
const REMINDER_MS = 35 * 60_000;

/** Lembrete uns 30 minutos antes de cada jogo (para quem segue um dos times e pediu) */
function remind(source: LiveSource, matches: Match[]) {
  const now = Date.now();
  for (const m of matches) {
    const left = Date.parse(m.utcDate) - now;
    const key = `${source.comp}:${m.id}`;
    if (m.status !== 'SCHEDULED' || m.home.tbd || m.away.tbd || left <= 0 || left > REMINDER_MS || reminded.has(key)) continue;
    reminded.add(key);
    const hora = new Date(m.utcDate).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    pushMessage([m.home.id, m.away.id], 'reminder', {
      title: `Daqui a pouco: ${m.home.shortName} x ${m.away.shortName}`,
      body: `${source.name} · começa às ${hora}`,
      icon: m.home.crest,
      tag: `lembrete-${key}`,
      url: source.jogoUrl(m.id),
    }).catch((err) => console.warn('Push:', (err as Error).message));
  }
}

const CHANCE_KINDS = [
  ['title', 'título'],
  ['libertadores', 'Libertadores'],
  ['relegation', 'rebaixamento'],
] as const;
const fmtPct = (p: number) => (p < 0.005 ? '0%' : p > 0.995 ? '100%' : `${Math.round(p * 100)}%`);

/** A chance que mais mudou entre duas simulações (título, Libertadores ou rebaixamento) */
function biggestChange(before: TeamOutlook | undefined, after: TeamOutlook | undefined) {
  if (!before || !after) return null;
  return CHANCE_KINDS.map(([key, label]) => ({ label, before: before[key], after: after[key] })).reduce((a, b) =>
    Math.abs(b.after - b.before) > Math.abs(a.after - a.before) ? b : a,
  );
}

// Chances logo depois do último resultado (para comparar com as de depois do próximo)
let outlookAtLastResult: Map<number, TeamOutlook> | null = null;

/** Fim de jogo no Brasileirão: resumo com as chances novas e aviso de mudança grande para os outros times */
async function resultNotices(events: LiveEvent[]) {
  const ended = events.filter((e) => e.type === 'fulltime');
  if (!ended.length) return;
  const a = await getAnalysis();
  const before = outlookAtLastResult ?? a.outlook;
  outlookAtLastResult = a.outlook;
  const inMatch = new Set<number>();
  const score = (e: (typeof ended)[number]) => `${e.home.shortName} ${e.homeGoals}×${e.awayGoals} ${e.away.shortName}`;
  for (const ev of ended) {
    if (ev.type !== 'fulltime') continue;
    inMatch.add(ev.home.id).add(ev.away.id);
    const line = (t: Team) => {
      const c = biggestChange(before.get(t.id), a.outlook.get(t.id));
      if (!c) return null;
      const pp = Math.round((c.after - c.before) * 100);
      return `${t.shortName}: ${fmtPct(c.after)} de ${c.label}${pp ? ` (${pp > 0 ? '+' : ''}${pp})` : ''}`;
    };
    await pushMessage([ev.home.id, ev.away.id], 'summary', {
      title: `Fim de jogo: ${score(ev)}`,
      body: [line(ev.home), line(ev.away)].filter(Boolean).join(' · '),
      icon: ev.home.crest,
      tag: `jogo-${ev.matchId}`,
      url: `/#/jogo/${ev.matchId}`,
    });
  }
  // Times que não jogaram, mas cuja chance mudou muito com esses resultados
  const results = ended.map((e) => (e.type === 'fulltime' ? score(e) : '')).join(', ');
  for (const [id, after] of a.outlook) {
    if (inMatch.has(id)) continue;
    const c = biggestChange(before.get(id), after);
    if (!c || Math.abs(c.after - c.before) < 0.15) continue;
    const team = a.teams.find((t) => t.id === id)!;
    await pushMessage([id], 'change', {
      title: `${team.shortName}: chance de ${c.label} ${c.after > c.before ? 'subiu' : 'caiu'} para ${fmtPct(c.after)}`,
      body: `Era ${fmtPct(c.before)} antes de ${results}`,
      icon: team.crest,
      tag: `chance-${id}`,
      url: `/#/time/${id}`,
    });
  }
}

/**
 * Lê os placares de um campeonato de tempos em tempos: avisa as páginas abertas
 * (para atualizarem na hora) e manda notificação de gol para os celulares inscritos.
 */
function watchLive(source: LiveSource) {
  let last: Map<number, Match> | null = null;
  const tick = async () => {
    let delay = 60_000;
    try {
      const matches = await source.getMatches();
      if (last) {
        const events = liveEvents([...last.values()], matches);
        if (matches.some((m) => !last!.has(m.id) || !sameScore(last!.get(m.id)!, m))) broadcast('update', { comp: source.comp, events });
        // No Brasileirão, quem pediu o resumo recebe ele no lugar do "Fim de jogo"
        const league = source.comp === 'bsa';
        pushEvents(events, source.jogoUrl, { withSummary: league }).catch((err) => console.warn('Push:', (err as Error).message));
        if (league) resultNotices(events).catch((err) => console.warn('Push (resumo):', (err as Error).message));
      } else if (source.comp === 'bsa') {
        // Primeira leitura: guarda as chances de agora, para comparar com as do próximo resultado
        getAnalysis().then((a) => (outlookAtLastResult ??= a.outlook), () => {});
      }
      remind(source, matches);
      last = new Map(matches.map((m) => [m.id, m]));
      if (isMatchTime(matches)) delay = source.liveDelay;
    } catch (err) {
      console.error(`Falha ao atualizar os placares (${source.name}):`, (err as Error).message);
    }
    setTimeout(tick, delay);
  };
  tick();
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(502).json({ error: err.message });
});

app.listen(config.port, () => {
  console.log(`⚽ Dashboard rodando em http://localhost:${config.port}`);
  console.log(`   Fonte de dados: ${provider.name} · modelo: ${MODEL_LABELS[config.model]}`);
  getAnalysis().catch(() => {}); // já começa a calcular (e a calibrar) sem esperar a primeira visita
  for (const source of LIVE_SOURCES) watchLive(source);
  if (!config.footballDataToken) console.log('   (crie um arquivo .env com FOOTBALL_DATA_TOKEN para usar dados reais)');
});
