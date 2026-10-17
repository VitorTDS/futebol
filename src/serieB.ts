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
import { computeStandings, currentMatchday, isFinished, teamsFrom, type StandingRow } from './model/standings.ts';
import { teamResults } from './model/teamProfile.ts';
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

export function createSerieB(opts: { year: number }) {
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
