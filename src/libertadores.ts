// Libertadores: grupos, mata-mata, chance de título e página de cada jogo.
// Usa a mesma football-data (competição CLI) e o mesmo modelo Dixon-Coles do
// Brasileirão, ajustado só com jogos da Libertadores (temporada atual + anterior).
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.ts';
import { getMatchCenter } from './data/espn.ts';
import { createFootballDataProvider } from './data/footballData.ts';
import { fitDixonColes } from './model/dixonColes.ts';
import { buildBracket, KNOCKOUT_STAGES, simulateKnockout, type KnockoutOutlook, type Tie } from './model/knockout.ts';
import { predictMatch, topScores, type FittedModel } from './model/prediction.ts';
import { mulberry32 } from './model/random.ts';
import { computeStandings, isFinished, teamsFrom, type StandingRow } from './model/standings.ts';
import { teamResults } from './model/teamProfile.ts';
import type { Match, Team } from './types.ts';

const STAGE_LABELS: Record<string, string> = { GROUP_STAGE: 'Fase de grupos', ...Object.fromEntries(KNOCKOUT_STAGES) };
const STAGE_ORDER = ['ROUND_1', 'ROUND_2', 'ROUND_3', 'GROUP_STAGE', 'PLAY_OFFS', 'QUARTER_FINALS', 'SEMI_FINALS', 'FINAL'];
/** Nos grupos, 1º e 2º vão às oitavas e o 3º cai para a Sul-Americana */
const GROUP_ZONES = { libertadores: 2, sulamericana: 3, relegation: 0 };

const provider = config.footballDataToken
  ? createFootballDataProvider({ token: config.footballDataToken, competition: 'CLI' })
  : null;

interface Analysis {
  matches: Match[];
  teams: Team[];
  model: FittedModel;
  bracket: Map<string, Tie[]>;
  knockout: KnockoutOutlook;
  groups: { group: string; rows: StandingRow[] }[];
  currentStage: string;
  updatedAt: string;
}

let last: { key: string; value: Analysis } | null = null;
let previousSeason: Match[] | null = null;

/** Final em campo neutro: média das duas ordens de mando, sem vantagem para ninguém. */
function neutral(model: FittedModel): FittedModel {
  return {
    ...model,
    expectedGoals: (h, a) => {
      const x = model.expectedGoals(h, a);
      const y = model.expectedGoals(a, h);
      return { home: (x.home + y.away) / 2, away: (x.away + y.home) / 2 };
    },
  };
}

const modelFor = (a: Analysis, m: Match) => (m.stage === 'FINAL' ? neutral(a.model) : a.model);

function currentStage(matches: Match[]): string {
  const stages = STAGE_ORDER.filter((s) => matches.some((m) => m.stage === s));
  const open = stages.find((s) => matches.some((m) => m.stage === s && !isFinished(m) && Date.parse(m.utcDate) > Date.now() - 7 * 86_400_000));
  return open ?? stages.at(-1) ?? 'GROUP_STAGE';
}

async function getAnalysis(): Promise<Analysis> {
  if (!provider) throw new Error('A Libertadores precisa do token da football-data (FOOTBALL_DATA_TOKEN no .env).');
  const matches = await provider.getMatches();
  const key = matches.map((m) => `${m.id}:${m.status}:${m.homeGoals}-${m.awayGoals}:${m.minute ?? ''}`).join('|');
  if (last?.key === key) return last.value;

  // Temporada anterior ajuda a conhecer os times (se a chave grátis tiver acesso)
  if (!previousSeason) {
    try {
      previousSeason = (await provider.getPreviousSeasons(1))[0]?.matches ?? [];
    } catch (err) {
      console.warn('Libertadores: sem a temporada anterior:', (err as Error).message);
      previousSeason = [];
    }
  }
  const real = (m: Match) => !m.home.tbd && !m.away.tbd;
  const teams = teamsFrom(matches.filter(real));
  const history = [...previousSeason, ...matches].filter((m) => real(m) && isFinished(m));
  const allTeams = teamsFrom(history.concat(matches.filter(real)));
  const model = fitDixonColes(allTeams, history, { asOf: new Date().toISOString(), timeDecay: config.defaultTimeDecay });

  const bracket = buildBracket(matches);
  const knockout = simulateKnockout(bracket, model, allTeams.map((t) => t.id), config.simulations, mulberry32(Date.now()));

  const groupNames = [...new Set(matches.filter((m) => m.stage === 'GROUP_STAGE' && m.group).map((m) => m.group!))].sort();
  const groups = groupNames.map((g) => {
    const games = matches.filter((m) => m.group === g);
    return { group: g.replace('GROUP_', ''), rows: computeStandings(teamsFrom(games), games) };
  });

  const value: Analysis = { matches, teams, model, bracket, knockout, groups, currentStage: currentStage(matches), updatedAt: new Date().toISOString() };
  last = { key, value };
  return value;
}

/**
 * Chance de título de cada clube, para as vagas do Brasileirão. Clube da Série A
 * vai pelo id (`brazilIds`); estrangeiro vai pelo nome, porque não dá vaga pelo Brasil.
 */
export async function libertadoresOdds(brazilIds: Set<number>): Promise<{ updatedAt: string; odds: { champion: number | string; p: number }[] }> {
  const a = await getAnalysis();
  const byId = new Map(a.teams.map((t) => [t.id, t]));
  const odds = [...a.knockout.champion]
    .filter(([, p]) => p > 0)
    .map(([id, p]) => ({ champion: brazilIds.has(id) ? id : (byId.get(id)?.name ?? `time ${id}`), p }));
  return { updatedAt: a.updatedAt, odds };
}

const route = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch(next);

export const libertadores = express.Router();

libertadores.get(
  '/overview',
  route(async (_req, res) => {
    const a = await getAnalysis();
    let stages = KNOCKOUT_STAGES.filter(([k]) => a.bracket.has(k) && !k.startsWith('ROUND_')).map(([key, label]) => ({
      key,
      label,
      ties: a.bracket.get(key)!.map((t, i) => ({
        teams: t.teams,
        legs: t.legs.map((m) => ({ id: m.id, utcDate: m.utcDate, status: m.status, minute: m.minute, home: m.home, away: m.away, homeGoals: m.homeGoals, awayGoals: m.awayGoals, penalties: m.penalties })),
        aggregate: t.aggregate,
        winner: t.winner?.id ?? null,
        advance: t.winner ? null : (a.knockout.advance.get(`${key}:${i}`) ?? null),
      })),
    }));
    // Ordena cada fase pelo caminho do chaveamento: os dois confrontos que levam a
    // um mesmo jogo da fase seguinte ficam juntos, na ordem desse jogo
    for (let i = stages.length - 1; i > 0; i--) {
      const prev = stages[i - 1].ties;
      const ordered: typeof prev = [];
      for (const t of stages[i].ties) {
        for (const team of t.teams) {
          const from = prev.find((p) => p.winner === team?.id);
          if (from && !ordered.includes(from)) ordered.push(from);
        }
      }
      stages[i - 1].ties = [...ordered, ...prev.filter((p) => !ordered.includes(p))];
    }
    const byId = new Map(a.teams.map((t) => [t.id, t]));
    const champions = [...a.knockout.champion]
      .map(([id, p]) => ({ team: byId.get(id)!, champion: p, final: a.knockout.reach.get('FINAL')?.get(id) ?? (p === 1 ? 1 : 0) }))
      .filter((c) => c.team)
      .sort((x, y) => y.champion - x.champion);
    res.json({
      source: provider!.name,
      updatedAt: a.updatedAt,
      simulations: config.simulations,
      currentStage: { key: a.currentStage, label: STAGE_LABELS[a.currentStage] },
      stages,
      champions,
    });
  }),
);

libertadores.get(
  '/groups',
  route(async (_req, res) => {
    const a = await getAnalysis();
    res.json({ zones: GROUP_ZONES, groups: a.groups });
  }),
);

libertadores.get(
  '/matches',
  route(async (req, res) => {
    const a = await getAnalysis();
    const stage = String(req.query.stage || a.currentStage);
    const matches = a.matches
      .filter((m) => m.stage === stage)
      .sort((x, y) => x.utcDate.localeCompare(y.utcDate))
      .map((m) => ({ ...m, prediction: isFinished(m) || m.home.tbd || m.away.tbd ? null : predictMatch(modelFor(a, m), m) }));
    res.json({
      stage: { key: stage, label: STAGE_LABELS[stage] ?? stage },
      currentStage: a.currentStage,
      stages: STAGE_ORDER.filter((s) => a.matches.some((m) => m.stage === s)).map((key) => ({ key, label: STAGE_LABELS[key] })),
      watchUrl: config.watchUrl,
      matches,
    });
  }),
);

libertadores.get(
  '/jogo/:id',
  route(async (req, res) => {
    const a = await getAnalysis();
    const m = a.matches.find((x) => x.id === Number(req.params.id));
    if (!m) {
      res.status(404).json({ error: 'Jogo não encontrado' });
      return;
    }
    const group = m.group ? a.groups.find((g) => `GROUP_${g.group}` === m.group) : null;
    const side = (team: Team) => ({
      standing: group?.rows.find((r) => r.team.id === team.id) ?? null,
      outlook: null,
      last: teamResults(team.id, a.matches)
        .filter((r) => r.match.utcDate < m.utcDate)
        .slice(-5)
        .reverse()
        .map((r) => ({ date: r.match.utcDate, opponent: r.opponent, home: r.home, goalsFor: r.goalsFor, goalsAgainst: r.goalsAgainst, result: r.result })),
    });
    const open = !isFinished(m) && !m.home.tbd && !m.away.tbd;

    // Confronto de mata-mata a que este jogo pertence
    let tie = null;
    const ties = m.stage ? a.bracket.get(m.stage) : undefined;
    const i = ties?.findIndex((t) => t.legs.some((l) => l.id === m.id)) ?? -1;
    if (ties && i >= 0) {
      const t = ties[i];
      tie = {
        stage: STAGE_LABELS[m.stage!],
        teams: t.teams,
        aggregate: t.aggregate,
        winner: t.winner?.id ?? null,
        advance: t.winner ? null : (a.knockout.advance.get(`${m.stage}:${i}`) ?? null),
        legs: t.legs.length,
      };
    }

    let espn = null;
    let espnError: string | null = null;
    try {
      espn = await getMatchCenter(m, 'conmebol.libertadores');
    } catch (err) {
      espnError = (err as Error).message;
    }

    res.json({
      competition: 'lib',
      stageLabel: STAGE_LABELS[m.stage ?? ''] ?? '',
      match: { ...m, prediction: open ? predictMatch(modelFor(a, m), m) : null },
      home: side(m.home),
      away: side(m.away),
      topScores: open ? topScores(modelFor(a, m), m) : null,
      stakes: null,
      tie,
      standings: group?.rows.map((r) => ({ position: r.position, team: r.team, played: r.played, points: r.points, goalDiff: r.goalDiff })) ?? null,
      zones: GROUP_ZONES,
      espn,
      espnError,
    });
  }),
);

libertadores.get(
  '/scorers',
  route(async (_req, res) => {
    if (!provider) throw new Error('A Libertadores precisa do token da football-data.');
    res.json({ source: provider.name, scorers: await provider.getScorers() });
  }),
);
