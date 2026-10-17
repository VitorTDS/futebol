// Copa em mata-mata (Libertadores, Copa do Brasil): grupos quando há, chaveamento,
// chance de título, página de cada jogo e de cada time. Cada copa entra com a sua
// fonte de dados e as suas fases; o modelo é o mesmo Dixon-Coles do Brasileirão,
// ajustado com os jogos da própria copa (temporada atual + anterior).
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.ts';
import type { Side } from './data/copas.ts';
import { getMatchCenter, type EspnLeague } from './data/espn.ts';
import { fitDixonColes } from './model/dixonColes.ts';
import { buildBracket, simulateKnockout, type KnockoutOutlook, type Tie } from './model/knockout.ts';
import { predictMatch, topScores, type FittedModel } from './model/prediction.ts';
import { mulberry32 } from './model/random.ts';
import { computeStandings, isFinished, teamsFrom, type StandingRow } from './model/standings.ts';
import { ratings, teamResults } from './model/teamProfile.ts';
import type { DataProvider, Match, Scorer, Team } from './types.ts';

export interface CupOptions {
  /** Prefixo nas rotas da API e do painel: lib, cdb */
  key: string;
  name: string;
  /** null quando falta configurar a fonte (a mensagem `missing` diz o quê) */
  provider: DataProvider | null;
  missing: string;
  espnLeague: EspnLeague;
  /** Fases de mata-mata, na ordem */
  stages: [key: string, label: string][];
  /** Todas as fases na ordem, com a de grupos se houver */
  stageOrder: string[];
  /** Primeira fase que aparece no chaveamento */
  bracketFrom: string;
  /** Quantos de cada grupo avançam e quem cai para a Sul-Americana (só se houver grupos) */
  groupZones?: { libertadores: number; sulamericana: number; relegation: number };
  /** Jogos de outra competição que ajudam o modelo a medir os times */
  extraHistory?: () => Promise<Match[]>;
}

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

const route = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch(next);

export function createCup(o: CupOptions) {
  const STAGE_LABELS: Record<string, string> = { GROUP_STAGE: 'Fase de grupos', ...Object.fromEntries(o.stages) };
  const STAGE_ORDER = o.stageOrder;
  const GROUP_ZONES = o.groupZones ?? null;
  const provider = o.provider;

  let last: { key: string; value: Analysis } | null = null;
  let previousSeason: Match[] | null = null;

  function currentStage(matches: Match[]): string {
    const stages = STAGE_ORDER.filter((s) => matches.some((m) => m.stage === s));
    const open = stages.find((s) => matches.some((m) => m.stage === s && !isFinished(m) && Date.parse(m.utcDate) > Date.now() - 7 * 86_400_000));
    return open ?? stages.at(-1) ?? 'GROUP_STAGE';
  }

  async function getAnalysis(): Promise<Analysis> {
    if (!provider) throw new Error(o.missing);
    const matches = await provider.getMatches();
    const key = matches.map((m) => `${m.id}:${m.status}:${m.homeGoals}-${m.awayGoals}:${m.minute ?? ''}`).join('|');
    if (last?.key === key) return last.value;

    // Temporada anterior ajuda a conhecer os times (se a chave grátis tiver acesso)
    if (!previousSeason) {
      try {
        previousSeason = (await provider.getPreviousSeasons(1))[0]?.matches ?? [];
      } catch (err) {
        console.warn(`${o.name}: sem a temporada anterior:`, (err as Error).message);
        previousSeason = [];
      }
    }
    const real = (m: Match) => !m.home.tbd && !m.away.tbd;
    const teams = teamsFrom(matches.filter(real));
    // Jogos de outra competição (o Brasileirão, na Copa do Brasil) ajudam a medir os times
    const extra = o.extraHistory ? await o.extraHistory().catch(() => [] as Match[]) : [];
    const history = [...previousSeason, ...extra, ...matches].filter((m) => real(m) && isFinished(m));
    const allTeams = teamsFrom(history.concat(matches.filter(real)));
    const model = fitDixonColes(allTeams, history, { asOf: new Date().toISOString(), timeDecay: config.defaultTimeDecay });

    const bracket = buildBracket(matches, o.stages);
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
   * Chance de cada desfecho, para as vagas do Brasileirão. Clube da Série A vai
   * pelo id (`brazilIds`); os outros vão pelo nome (estrangeiro não dá vaga pelo
   * Brasil; clube de outra divisão ocupa a vaga sem passar pela tabela).
   * Com `withRunnerUp`, cada desfecho é uma final (campeão e vice).
   */
  async function outcomes(brazilIds: Set<number>, withRunnerUp = false): Promise<{ updatedAt: string; odds: { champion: Side; runnerUp?: Side; p: number }[] }> {
    const a = await getAnalysis();
    const byId = new Map(a.teams.map((t) => [t.id, t]));
    const side = (id: number): Side => (brazilIds.has(id) ? id : (byId.get(id)?.name ?? `time ${id}`));
    const odds = withRunnerUp
      ? [...a.knockout.podium].map(([k, p]) => {
          const [champion, runnerUp] = k.split('>').map(Number);
          return { champion: side(champion), runnerUp: side(runnerUp), p };
        })
      : [...a.knockout.champion].filter(([, p]) => p > 0).map(([id, p]) => ({ champion: side(id), p }));
    return { updatedAt: a.updatedAt, odds };
  }

  const router = express.Router();

  router.get(
    '/overview',
    route(async (_req, res) => {
      const a = await getAnalysis();
      const from = o.stages.findIndex(([k]) => k === o.bracketFrom);
      let stages = o.stages.filter(([k], i) => a.bracket.has(k) && i >= from).map(([key, label]) => ({
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
        name: o.name,
        source: provider!.name,
        updatedAt: a.updatedAt,
        simulations: config.simulations,
        currentStage: { key: a.currentStage, label: STAGE_LABELS[a.currentStage] },
        stages,
        champions,
      });
    }),
  );

  router.get(
    '/groups',
    route(async (_req, res) => {
      const a = await getAnalysis();
      res.json({ zones: GROUP_ZONES, groups: a.groups });
    }),
  );

  router.get(
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

  router.get(
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
        espn = await getMatchCenter(m, o.espnLeague);
      } catch (err) {
        espnError = (err as Error).message;
      }

      res.json({
        competition: o.key,
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

  router.get(
    '/time/:id',
    route(async (req, res) => {
      const a = await getAnalysis();
      const id = Number(req.params.id);
      const team = a.teams.find((t) => t.id === id);
      if (!team) {
        res.status(404).json({ error: `Time não encontrado na ${o.name}` });
        return;
      }
      const group = a.groups.find((g) => g.rows.some((r) => r.team.id === id)) ?? null;
      // Pela data: a fonte às vezes deixa um jogo antigo como "agendado" (na Libertadores 2026, DIM × FLA de maio)
      const groupDone = a.matches.filter((m) => m.stage === 'GROUP_STAGE').every((m) => isFinished(m) || Date.parse(m.utcDate) < Date.now());

      // Caminho fase a fase: confronto, placar agregado e se passou, caiu ou a chance de passar
      const journey = [];
      for (const stage of STAGE_ORDER) {
        const label = STAGE_LABELS[stage];
        if (stage === 'GROUP_STAGE') {
          const row = group?.rows.find((r) => r.team.id === id);
          if (!group || !row || !GROUP_ZONES) continue;
          const result = !groupDone ? null : row.position <= GROUP_ZONES.libertadores ? 'passou' : 'eliminado';
          journey.push({ stage, label, group: group.group, position: row.position, points: row.points, result, sulamericana: groupDone && row.position === GROUP_ZONES.sulamericana });
          continue;
        }
        const ties = a.bracket.get(stage);
        if (!ties) continue;
        const i = ties.findIndex((t) => t.teams.some((x) => x?.id === id));
        if (i < 0) {
          // Fase futura: chance de chegar até ela
          const reach = a.knockout.reach.get(stage)?.get(id) ?? 0;
          if (reach > 0) journey.push({ stage, label, reach });
          continue;
        }
        const t = ties[i];
        const first = t.teams[0]?.id === id;
        const adv = a.knockout.advance.get(`${stage}:${i}`);
        journey.push({
          stage,
          label,
          opponent: t.teams[first ? 1 : 0],
          aggregate: first ? t.aggregate : [t.aggregate[1], t.aggregate[0]],
          played: t.legs.some((l) => isFinished(l) || l.status === 'LIVE'),
          result: t.winner ? (t.winner.id === id ? 'passou' : 'eliminado') : null,
          advance: t.winner || adv == null ? null : first ? adv : 1 - adv,
        });
      }

      const results = teamResults(id, a.matches);
      const sum = (f: (r: (typeof results)[number]) => number) => results.reduce((s, r) => s + f(r), 0);
      // Força pelo modelo, comparada com os outros times desta Libertadores
      const rated = ratings(a.model, a.teams);
      const rank = (key: 'attack' | 'defense') =>
        [...rated.values()].filter((r) => (key === 'attack' ? r.attack > rated.get(id)![key] : r.defense < rated.get(id)![key])).length + 1;
      let scorers: Scorer[] = [];
      try {
        scorers = ((await provider!.getScorers()) ?? []).filter((s) => s.team.id === id);
      } catch {
        // Artilharia é um extra: sem ela, a página abre do mesmo jeito
      }

      res.json({
        team,
        champion: a.knockout.champion.get(id) ?? 0,
        journey,
        group: group ? { name: group.group, rows: group.rows } : null,
        zones: GROUP_ZONES,
        stats: {
          played: results.length,
          won: results.filter((r) => r.result === 'V').length,
          drawn: results.filter((r) => r.result === 'E').length,
          lost: results.filter((r) => r.result === 'D').length,
          goalsFor: sum((r) => r.goalsFor),
          goalsAgainst: sum((r) => r.goalsAgainst),
        },
        ratings: { ...rated.get(id)!, attackRank: rank('attack'), defenseRank: rank('defense'), of: a.teams.length },
        scorers,
        watchUrl: config.watchUrl,
        upcoming: a.matches
          .filter((m) => !isFinished(m) && (m.home.id === id || m.away.id === id))
          .sort((x, y) => x.utcDate.localeCompare(y.utcDate))
          .map((m) => ({ ...m, prediction: m.home.tbd || m.away.tbd ? null : predictMatch(modelFor(a, m), m) })),
        results: results.reverse().map((r) => ({ ...r, stageLabel: STAGE_LABELS[r.match.stage ?? ''] ?? '' })),
      });
    }),
  );

  router.get(
    '/scorers',
    route(async (_req, res) => {
      if (!provider) throw new Error(o.missing);
      res.json({ source: provider.name, scorers: await provider.getScorers() });
    }),
  );

  /** Jogos da copa (para outras copas usarem no modelo) */
  const matches = async () => (await getAnalysis()).matches;

  return { router, outcomes, matches };
}
