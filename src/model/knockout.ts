// Mata-mata de copa (Libertadores): monta os confrontos a partir dos jogos e
// sorteia o que falta até a final, para dar a chance de cada time avançar.
import type { Leg } from '../data/copas.ts';
import { createTieSimulator } from './cups.ts';
import { remainingFraction, type FittedModel } from './prediction.ts';
import type { Rng } from './random.ts';
import type { Match, Team } from '../types.ts';

/** Fases de mata-mata da Libertadores, na ordem */
export const KNOCKOUT_STAGES: [key: string, label: string][] = [
  ['ROUND_1', 'Primeira fase'],
  ['ROUND_2', 'Segunda fase'],
  ['ROUND_3', 'Terceira fase'],
  ['PLAY_OFFS', 'Oitavas de final'],
  ['QUARTER_FINALS', 'Quartas de final'],
  ['SEMI_FINALS', 'Semifinal'],
  ['FINAL', 'Final'],
];

export interface Tie {
  stage: string;
  /** Os dois times (ou null, vaga ainda sem dono), na ordem do primeiro jogo */
  teams: [Team | null, Team | null];
  legs: Match[];
  /** Gols somados de cada time nos jogos já disputados */
  aggregate: [number, number];
  /** Quem avançou, quando o confronto já acabou */
  winner: Team | null;
}

const real = (t: Team) => !t.tbd;

/** Agrupa os jogos de cada fase em confrontos (ida e volta, ou jogo único). */
export function buildBracket(matches: Match[]): Map<string, Tie[]> {
  const bracket = new Map<string, Tie[]>();
  for (const [stage] of KNOCKOUT_STAGES) {
    const games = matches.filter((m) => m.stage === stage).sort((a, b) => a.utcDate.localeCompare(b.utcDate));
    if (!games.length) continue;
    const ties = new Map<string, Tie>();
    for (const m of games) {
      const known = real(m.home) && real(m.away);
      const key = known ? [m.home.id, m.away.id].sort((a, b) => a - b).join('-') : `tbd-${m.id}`;
      let tie = ties.get(key);
      if (!tie) {
        tie = { stage, teams: [known ? m.home : null, known ? m.away : null], legs: [], aggregate: [0, 0], winner: null };
        ties.set(key, tie);
      }
      tie.legs.push(m);
    }
    for (const tie of ties.values()) settle(tie);
    bracket.set(stage, [...ties.values()]);
  }
  return bracket;
}

/** Soma os gols e, se todos os jogos acabaram, diz quem passou (pênaltis desempatam). */
function settle(tie: Tie) {
  const [a, b] = tie.teams;
  if (!a || !b) return;
  const played = tie.legs.filter((m) => m.status === 'FINISHED' && m.homeGoals != null);
  for (const m of played) {
    const aHome = m.home.id === a.id;
    tie.aggregate[0] += (aHome ? m.homeGoals : m.awayGoals)!;
    tie.aggregate[1] += (aHome ? m.awayGoals : m.homeGoals)!;
  }
  // Jogo adiado/cancelado que ficou para trás (mais de uma semana) não conta como pendente
  const stale = Date.now() - 7 * 86_400_000;
  const pending = tie.legs.filter((m) => m.status !== 'FINISHED' && Date.parse(m.utcDate) > stale);
  if (pending.length || !played.length) return;
  const [ga, gb] = tie.aggregate;
  if (ga !== gb) {
    tie.winner = ga > gb ? a : b;
    return;
  }
  const last = played.at(-1)!;
  if (last.penalties) {
    const homeWon = last.penalties[0] > last.penalties[1];
    tie.winner = homeWon === (last.home.id === a.id) ? a : b;
  }
}

export interface KnockoutOutlook {
  /** Chance de cada time ser campeão */
  champion: Map<number, number>;
  /** Chance de cada time chegar a cada fase (chave da fase) */
  reach: Map<string, Map<number, number>>;
  /** Chance do primeiro time de cada confronto avançar, pela chave `${fase}:${índice}` */
  advance: Map<string, number>;
}

function toLeg(m: Match): Leg {
  if (m.status === 'FINISHED' && m.homeGoals != null) {
    return { home: m.home.id, away: m.away.id, score: [m.homeGoals, m.awayGoals!], penalties: m.penalties ?? null };
  }
  if (m.status === 'LIVE') {
    return { home: m.home.id, away: m.away.id, live: { score: [m.homeGoals ?? 0, m.awayGoals ?? 0], remaining: remainingFraction(m) } };
  }
  return { home: m.home.id, away: m.away.id };
}

/**
 * Sorteia os confrontos que faltam, fase a fase. Vagas ainda sem dono são
 * preenchidas pelos vencedores da fase anterior, na ordem dos confrontos
 * (1º x 2º, 3º x 4º...), e a final é em campo neutro.
 */
export function simulateKnockout(bracket: Map<string, Tie[]>, model: FittedModel, teamIds: number[], runs: number, rng: Rng): KnockoutOutlook {
  const { tie } = createTieSimulator(model, teamIds);
  const stages = KNOCKOUT_STAGES.map(([k]) => k).filter((k) => bracket.has(k));
  // Começa na primeira fase que ainda tem confronto em aberto
  const start = stages.findIndex((k) => bracket.get(k)!.some((t) => !t.winner));
  const champion = new Map<number, number>();
  const reach = new Map<string, Map<number, number>>(stages.map((k) => [k, new Map()]));
  const advance = new Map<string, number>();
  const add = (map: Map<number, number>, id: number) => map.set(id, (map.get(id) ?? 0) + 1);
  if (start < 0) {
    const final = bracket.get('FINAL')?.[0];
    if (final?.winner) champion.set(final.winner.id, 1);
    return { champion, reach, advance };
  }

  for (let run = 0; run < runs; run++) {
    let winners: number[] = [];
    for (let s = start; s < stages.length; s++) {
      const stage = stages[s];
      const ties = bracket.get(stage)!;
      const next: number[] = [];
      ties.forEach((t, i) => {
        // Vaga sem dono: vencedores da fase anterior, em pares
        const a = t.teams[0]?.id ?? winners[2 * i];
        const b = t.teams[1]?.id ?? winners[2 * i + 1];
        if (a == null || b == null) return;
        add(reach.get(stage)!, a);
        add(reach.get(stage)!, b);
        let w: number;
        if (t.winner) w = t.winner.id;
        else if (t.teams[0]) {
          const legs = t.legs.filter((m) => m.status === 'FINISHED' || Date.parse(m.utcDate) > Date.now() - 7 * 86_400_000);
          w = tie(legs.map(toLeg), stage === 'FINAL', rng).winner as number;
        } else {
          // Final ainda sem os dois times: jogo único em campo neutro
          w = tie([{ home: a, away: b }], true, rng).winner as number;
        }
        if (w === a) advance.set(`${stage}:${i}`, (advance.get(`${stage}:${i}`) ?? 0) + 1);
        next.push(w);
      });
      winners = next;
    }
    if (winners.length === 1) add(champion, winners[0]);
  }

  const norm = (map: Map<number, number>) => {
    for (const [k, v] of map) map.set(k, v / runs);
  };
  norm(champion);
  for (const m of reach.values()) norm(m);
  for (const [k, v] of advance) advance.set(k, v / runs);
  return { champion, reach, advance };
}
