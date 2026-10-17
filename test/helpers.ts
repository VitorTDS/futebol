import type { Match, Team } from '../src/types.ts';

export function team(id: number, tla = `T${id}`): Team {
  return { id, name: `Time ${id}`, shortName: `Time ${id}`, tla };
}

let nextId = 1;

/** Jogo encerrado (com placar) ou por disputar (sem placar). */
export function match(matchday: number, home: Team, away: Team, score?: [number, number], status?: Match['status']): Match {
  return {
    id: nextId++,
    matchday,
    utcDate: new Date(Date.UTC(2026, 0, 1) + matchday * 7 * 86_400_000).toISOString(),
    status: status ?? (score ? 'FINISHED' : 'SCHEDULED'),
    home,
    away,
    homeGoals: score ? score[0] : null,
    awayGoals: score ? score[1] : null,
  };
}
