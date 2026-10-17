import type { Match, Team } from '../types.ts';

export interface StandingRow {
  position: number;
  team: Team;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDiff: number;
  points: number;
  /** Últimos 5 jogos, do mais antigo ao mais recente: V, E ou D */
  form: string[];
}

export function isFinished(m: Match): m is Match & { homeGoals: number; awayGoals: number } {
  return m.status === 'FINISHED' && m.homeGoals !== null && m.awayGoals !== null;
}

/** Lista de times (sem repetição) que aparecem nos jogos. */
export function teamsFrom(matches: Match[]): Team[] {
  const byId = new Map<number, Team>();
  for (const m of matches) {
    byId.set(m.home.id, m.home);
    byId.set(m.away.id, m.away);
  }
  return [...byId.values()];
}

/** Critérios do Brasileirão: pontos, vitórias, saldo de gols, gols marcados. */
export function compareRows(a: StandingRow, b: StandingRow): number {
  return (
    b.points - a.points ||
    b.won - a.won ||
    b.goalDiff - a.goalDiff ||
    b.goalsFor - a.goalsFor ||
    a.team.name.localeCompare(b.team.name)
  );
}

export function computeStandings(teams: Team[], matches: Match[], upToMatchday = Infinity): StandingRow[] {
  const rows = new Map<number, StandingRow>(
    teams.map((team) => [
      team.id,
      { position: 0, team, played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, goalDiff: 0, points: 0, form: [] },
    ]),
  );

  const finished = matches
    .filter((m) => isFinished(m) && m.matchday <= upToMatchday)
    .sort((a, b) => a.utcDate.localeCompare(b.utcDate));

  for (const m of finished) {
    const home = rows.get(m.home.id)!;
    const away = rows.get(m.away.id)!;
    const hg = m.homeGoals!;
    const ag = m.awayGoals!;
    apply(home, hg, ag);
    apply(away, ag, hg);
  }

  const sorted = [...rows.values()].sort(compareRows);
  sorted.forEach((row, i) => {
    row.position = i + 1;
    row.goalDiff = row.goalsFor - row.goalsAgainst;
    row.form = row.form.slice(-5);
  });
  return sorted;
}

/** Posição de cada time ao fim de cada rodada já jogada. */
export function computeEvolution(teams: Team[], matches: Match[]) {
  const lastPlayed = Math.max(0, ...matches.filter(isFinished).map((m) => m.matchday));
  const positions = new Map<number, number[]>(teams.map((t) => [t.id, []]));
  for (let d = 1; d <= lastPlayed; d++) {
    for (const row of computeStandings(teams, matches, d)) positions.get(row.team.id)!.push(row.position);
  }
  return { matchdays: Array.from({ length: lastPlayed }, (_, i) => i + 1), positions };
}

function apply(row: StandingRow, scored: number, conceded: number) {
  row.played++;
  row.goalsFor += scored;
  row.goalsAgainst += conceded;
  row.goalDiff = row.goalsFor - row.goalsAgainst;
  if (scored > conceded) {
    row.won++;
    row.points += 3;
    row.form.push('V');
  } else if (scored === conceded) {
    row.drawn++;
    row.points += 1;
    row.form.push('E');
  } else {
    row.lost++;
    row.form.push('D');
  }
}
