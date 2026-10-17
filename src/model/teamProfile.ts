import type { FittedModel } from './prediction.ts';
import { isFinished } from './standings.ts';
import type { Match, Team } from '../types.ts';

export type Result = 'V' | 'E' | 'D';

export interface SplitStats {
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
  /** Aproveitamento: pontos ganhos / pontos disputados */
  efficiency: number;
}

export interface TeamResult {
  match: Match;
  home: boolean;
  opponent: Team;
  goalsFor: number;
  goalsAgainst: number;
  result: Result;
}

export interface Streaks {
  /** Sequência atual: ex. 3 vitórias seguidas */
  current: { result: Result; length: number } | null;
  /** Jogos seguidos sem perder / sem vencer, contando do mais recente */
  unbeaten: number;
  winless: number;
  longestWinning: number;
  longestUnbeaten: number;
  biggestWin: TeamResult | null;
  biggestLoss: TeamResult | null;
}

export interface Ratings {
  /** Gols que o modelo espera que o time marque contra um adversário médio, relativo à média da liga (1 = na média) */
  attack: number;
  /** Gols que o modelo espera que o time sofra, relativo à média da liga (abaixo de 1 = defesa melhor que a média) */
  defense: number;
}

export function teamResults(teamId: number, matches: Match[]): TeamResult[] {
  return matches
    .filter((m) => isFinished(m) && (m.home.id === teamId || m.away.id === teamId))
    .sort((a, b) => a.utcDate.localeCompare(b.utcDate))
    .map((m) => {
      const home = m.home.id === teamId;
      const goalsFor = home ? m.homeGoals! : m.awayGoals!;
      const goalsAgainst = home ? m.awayGoals! : m.homeGoals!;
      return {
        match: m,
        home,
        opponent: home ? m.away : m.home,
        goalsFor,
        goalsAgainst,
        result: goalsFor > goalsAgainst ? 'V' : goalsFor === goalsAgainst ? 'E' : 'D',
      };
    });
}

export function splitStats(results: TeamResult[]): SplitStats {
  const s = { played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, points: 0, efficiency: 0 };
  for (const r of results) {
    s.played++;
    s.goalsFor += r.goalsFor;
    s.goalsAgainst += r.goalsAgainst;
    if (r.result === 'V') {
      s.won++;
      s.points += 3;
    } else if (r.result === 'E') {
      s.drawn++;
      s.points++;
    } else {
      s.lost++;
    }
  }
  s.efficiency = s.played ? s.points / (3 * s.played) : 0;
  return s;
}

/** `results` em ordem cronológica. */
export function streaks(results: TeamResult[]): Streaks {
  const recentFirst = [...results].reverse();
  const countWhile = (pred: (r: TeamResult) => boolean) => {
    let n = 0;
    while (n < recentFirst.length && pred(recentFirst[n])) n++;
    return n;
  };

  let longestWinning = 0;
  let longestUnbeaten = 0;
  let win = 0;
  let unbeaten = 0;
  let biggestWin: TeamResult | null = null;
  let biggestLoss: TeamResult | null = null;
  const margin = (r: TeamResult) => r.goalsFor - r.goalsAgainst;

  for (const r of results) {
    win = r.result === 'V' ? win + 1 : 0;
    unbeaten = r.result !== 'D' ? unbeaten + 1 : 0;
    longestWinning = Math.max(longestWinning, win);
    longestUnbeaten = Math.max(longestUnbeaten, unbeaten);
    // Em caso de mesma diferença, vale o jogo com mais gols marcados
    if (r.result === 'V' && (!biggestWin || margin(r) > margin(biggestWin) || (margin(r) === margin(biggestWin) && r.goalsFor > biggestWin.goalsFor))) {
      biggestWin = r;
    }
    if (r.result === 'D' && (!biggestLoss || margin(r) < margin(biggestLoss) || (margin(r) === margin(biggestLoss) && r.goalsAgainst > biggestLoss.goalsAgainst))) {
      biggestLoss = r;
    }
  }

  const last = recentFirst[0];
  return {
    current: last ? { result: last.result, length: countWhile((r) => r.result === last.result) } : null,
    unbeaten: countWhile((r) => r.result !== 'D'),
    winless: countWhile((r) => r.result !== 'V'),
    longestWinning,
    longestUnbeaten,
    biggestWin,
    biggestLoss,
  };
}

/**
 * Força de ataque e defesa segundo o modelo: média dos gols esperados contra
 * todos os outros times (em casa e fora), comparada com a média da liga.
 */
export function ratings(model: FittedModel, teams: Team[]): Map<number, Ratings> {
  const raw = teams.map((t) => {
    let scored = 0;
    let conceded = 0;
    let n = 0;
    for (const o of teams) {
      if (o.id === t.id) continue;
      const asHome = model.expectedGoals(t.id, o.id);
      const asAway = model.expectedGoals(o.id, t.id);
      scored += asHome.home + asAway.away;
      conceded += asHome.away + asAway.home;
      n += 2;
    }
    return { id: t.id, scored: scored / n, conceded: conceded / n };
  });

  const avg = raw.reduce((s, r) => s + r.scored, 0) / raw.length;
  return new Map(raw.map((r) => [r.id, { attack: r.scored / avg, defense: r.conceded / avg }]));
}
