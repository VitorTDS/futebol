// Série B: tabela com chance de título, de acesso (4 primeiros) e de queda (4
// últimos), jogos por rodada e página de cada jogo. Dados da ESPN; o modelo é o
// mesmo Dixon-Coles, ajustado com a Série B desta temporada e da anterior.
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.ts';
import { getMatchCenter } from './data/espn.ts';
import { createEspnLeagueProvider } from './data/espnCup.ts';
import { resilient } from './data/resilient.ts';
import { fitDixonColes } from './model/dixonColes.ts';
import { predictMatch, topScores, type FittedModel } from './model/prediction.ts';
import { mulberry32 } from './model/random.ts';
import { simulateSeason, type TeamOutlook } from './model/simulation.ts';
import { computeEvolution, computeStandings, currentMatchday, isFinished, isUpcoming, teamsFrom, type StandingRow } from './model/standings.ts';
import { ratings, teamResults } from './model/teamProfile.ts';
import { pickedScores } from './model/whatif.ts';
import type { Match, Team } from './types.ts';

/** Na simulação, a "Libertadores" faz o papel do acesso (4 primeiros); 4 caem para a Série C */
const ZONES = { libertadores: 4, sulamericana: 0, relegation: 4 };

interface Analysis {
  matches: Match[];
  teams: Team[];
  model: FittedModel;
  standings: StandingRow[];
  outlook: Map<number, TeamOutlook>;
  currentMatchday: number;
  totalMatchdays: number;
  updatedAt: string;
}

const route = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch(next);

/** Resumo do time numa copa (a página do time mostra a Copa do Brasil junto) */
type CupSummary = (teamId: number) => Promise<unknown>;

export function createSerieB(opts: { year: number; cups?: CupSummary[] }) {
  const provider = resilient(createEspnLeagueProvider({ league: 'bra.2', year: opts.year }), 'Série B');
  let last: { key: string; value: Analysis } | null = null;
  let previous: Match[] | null = null;

  async function getAnalysis(): Promise<Analysis> {
    const matches = await provider.getMatches();
    const key = matches.map((m) => `${m.id}:${m.status}:${m.homeGoals}-${m.awayGoals}:${m.minute ?? ''}`).join('|');
    if (last?.key === key) return last.value;
    if (!previous) {
      try {
        previous = (await provider.getPreviousSeasons(1))[0]?.matches ?? [];
      } catch (err) {
        console.warn('Série B: sem a temporada anterior:', (err as Error).message);
        previous = [];
      }
    }
    const teams = teamsFrom(matches);
    // Temporada anterior ajuda a conhecer os times (quem caiu da Série A ou subiu da C fica com o que jogou aqui)
    const history = [...previous, ...matches].filter(isFinished);
    const model = fitDixonColes(teamsFrom([...history, ...matches]), history, { asOf: new Date().toISOString(), timeDecay: config.defaultTimeDecay });
    const out = simulateSeason(teams, matches, model, { runs: config.simulations, zones: ZONES, rng: mulberry32(Date.now()) });
    const value: Analysis = {
      matches,
      teams,
      model,
      standings: computeStandings(teams, matches),
      outlook: new Map(out.teams.map((o) => [o.teamId, o])),
      currentMatchday: currentMatchday(matches),
      totalMatchdays: Math.max(...matches.map((m) => m.matchday)),
      updatedAt: new Date().toISOString(),
    };
    last = { key, value };
    return value;
  }

  const router = express.Router();

  router.get(
    '/overview',
    route(async (_req, res) => {
      const a = await getAnalysis();
      res.json({
        source: provider.name,
        updatedAt: a.updatedAt,
        simulations: config.simulations,
        currentMatchday: a.currentMatchday,
        totalMatchdays: a.totalMatchdays,
        zones: { promotion: ZONES.libertadores, relegation: ZONES.relegation },
        standings: a.standings.map((row) => {
          const o = a.outlook.get(row.team.id)!;
          return { ...row, outlook: { title: o.title, promotion: o.libertadores, relegation: o.relegation, expectedPoints: o.expectedPoints } };
        }),
      });
    }),
  );

  router.get(
    '/matches',
    route(async (req, res) => {
      const a = await getAnalysis();
      const matchday = Number(req.query.matchday) || a.currentMatchday;
      res.json({
        matchday,
        currentMatchday: a.currentMatchday,
        totalMatchdays: a.totalMatchdays,
        watchUrl: config.watchUrl,
        matches: a.matches
          .filter((m) => m.matchday === matchday)
          .map((m) => ({ ...m, prediction: isFinished(m) ? null : predictMatch(a.model, m) })),
      });
    }),
  );

  router.get(
    '/jogo/:id',
    route(async (req, res) => {
      const a = await getAnalysis();
      const m = a.matches.find((x) => x.id === Number(req.params.id));
      if (!m) {
        res.status(404).json({ error: 'Jogo não encontrado' });
        return;
      }
      const open = !isFinished(m);
      const side = (team: Team) => ({
        standing: a.standings.find((r) => r.team.id === team.id) ?? null,
        outlook: null,
        last: teamResults(team.id, a.matches)
          .filter((r) => r.match.utcDate < m.utcDate)
          .slice(-5)
          .reverse()
          .map((r) => ({ date: r.match.utcDate, opponent: r.opponent, home: r.home, goalsFor: r.goalsFor, goalsAgainst: r.goalsAgainst, result: r.result })),
      });
      let espn = null;
      let espnError: string | null = null;
      try {
        espn = await getMatchCenter(m, 'bra.2');
      } catch (err) {
        espnError = (err as Error).message;
      }
      res.json({
        competition: 'serieb',
        stageLabel: `Rodada ${m.matchday}`,
        match: { ...m, prediction: open ? predictMatch(a.model, m) : null },
        home: side(m.home),
        away: side(m.away),
        topScores: open ? topScores(a.model, m) : null,
        stakes: null,
        tie: null,
        standings: a.standings.map((r) => ({ position: r.position, team: r.team, played: r.played, points: r.points, goalDiff: r.goalDiff })),
        // Na tabela do jogo: 4 primeiros sobem (verde) e 4 últimos caem (vermelho)
        zones: { libertadores: ZONES.libertadores, sulamericana: ZONES.libertadores, relegation: ZONES.relegation },
        espn,
        espnError,
      });
    }),
  );

  // ---------- Página do time ----------

  router.get(
    '/time/:id',
    route(async (req, res) => {
      const a = await getAnalysis();
      const id = Number(req.params.id);
      const standing = a.standings.find((r) => r.team.id === id);
      if (!standing) {
        res.status(404).json({ error: 'Time não encontrado na Série B' });
        return;
      }
      const o = a.outlook.get(id)!;
      const rated = ratings(a.model, a.teams);
      const own = rated.get(id)!;
      const all = [...rated.values()];
      const { matchdays, positions } = computeEvolution(a.teams, a.matches);
      // O mesmo time nas copas que ele joga (a Copa do Brasil tem clubes da Série B)
      const cups = (await Promise.allSettled((opts.cups ?? []).map((c) => c(id))))
        .map((r) => (r.status === 'fulfilled' ? r.value : null))
        .filter((c) => c != null);
      res.json({
        team: standing.team,
        standing,
        totalTeams: a.teams.length,
        zones: { promotion: ZONES.libertadores, relegation: ZONES.relegation },
        outlook: { title: o.title, promotion: o.libertadores, relegation: o.relegation, expectedPoints: o.expectedPoints, positionProbs: o.positionProbs },
        ratings: {
          ...own,
          attackRank: all.filter((r) => r.attack > own.attack).length + 1,
          defenseRank: all.filter((r) => r.defense < own.defense).length + 1,
        },
        evolution: { matchdays, positions: positions.get(id) },
        results: teamResults(id, a.matches).reverse(),
        upcoming: a.matches
          .filter((m) => isUpcoming(m) && (m.home.id === id || m.away.id === id))
          .sort((x, y) => x.utcDate.localeCompare(y.utcDate))
          .map((m) => ({ ...m, prediction: predictMatch(a.model, m) })),
        cups,
        watchUrl: config.watchUrl,
      });
    }),
  );

  // ---------- "E se" da Série B (a briga pelo acesso e contra a queda) ----------

  const WHATIF_RUNS = 4000;
  // Mesmos sorteios no cenário-base e no "e se": a diferença vem só dos palpites
  const WHATIF_SEED = 2026;
  let whatifBase: { analysis: Analysis; teams: TeamOutlook[] } | null = null;
  const simulate = (a: Analysis, forced?: Map<number, [number, number]>) =>
    simulateSeason(a.teams, a.matches, a.model, { runs: WHATIF_RUNS, zones: ZONES, rng: mulberry32(WHATIF_SEED), forced }).teams;

  router.get(
    '/whatif',
    route(async (_req, res) => {
      const a = await getAnalysis();
      res.json({
        currentMatchday: a.currentMatchday,
        totalMatchdays: a.totalMatchdays,
        matches: a.matches
          .filter((m) => !isFinished(m))
          .sort((x, y) => x.matchday - y.matchday || x.utcDate.localeCompare(y.utcDate))
          .map((m) => ({ ...m, prediction: predictMatch(a.model, m) })),
        standings: a.standings.map((row) => ({ position: row.position, team: row.team, points: row.points, outlook: a.outlook.get(row.team.id) })),
      });
    }),
  );

  router.post(
    '/whatif',
    express.json({ limit: '16kb' }),
    route(async (req, res) => {
      const a = await getAnalysis();
      if (whatifBase?.analysis !== a) whatifBase = { analysis: a, teams: simulate(a) };
      const forced = pickedScores(a.matches, req.body?.picks ?? {});
      res.json({ runs: WHATIF_RUNS, teams: simulate(a, forced), base: whatifBase.teams });
    }),
  );

  /** Jogos entre duas datas, com a previsão (para a agenda) */
  async function agenda(from: number, to: number) {
    const a = await getAnalysis();
    return a.matches
      .filter((m) => Date.parse(m.utcDate) >= from && Date.parse(m.utcDate) <= to)
      .map((m) => ({ ...m, comp: 'serieb', stageLabel: `Rodada ${m.matchday}`, prediction: isFinished(m) ? null : predictMatch(a.model, m) }));
  }

  return {
    router,
    agenda,
    liveMatches: () => provider.refreshMatches(),
    health: () => provider.health(),
  };
}
