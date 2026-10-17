// Compara duas leituras dos jogos e diz o que aconteceu entre elas (gol, início, fim).
import type { Match, Team } from '../types.ts';

export type LiveEvent =
  | { type: 'goal'; matchId: number; side: 'home' | 'away'; home: Team; away: Team; homeGoals: number; awayGoals: number; minute: number | null }
  | { type: 'kickoff'; matchId: number; home: Team; away: Team }
  | { type: 'fulltime'; matchId: number; home: Team; away: Team; homeGoals: number; awayGoals: number };

export function liveEvents(before: Match[], after: Match[]): LiveEvent[] {
  const old = new Map(before.map((m) => [m.id, m]));
  const events: LiveEvent[] = [];
  for (const m of after) {
    const o = old.get(m.id);
    if (!o) continue;
    const { home, away } = m;
    if (o.status === 'SCHEDULED' && m.status === 'LIVE') events.push({ type: 'kickoff', matchId: m.id, home, away });

    const hg = m.homeGoals ?? 0;
    const ag = m.awayGoals ?? 0;
    // Só conta gol em jogo que já estava rolando (a primeira leitura de um jogo encerrado não é "gol")
    if (o.status === 'LIVE' || m.status === 'LIVE') {
      const base = { matchId: m.id, home, away, homeGoals: hg, awayGoals: ag, minute: m.minute ?? null };
      for (let g = (o.homeGoals ?? 0) + 1; g <= hg; g++) events.push({ type: 'goal', side: 'home', ...base });
      for (let g = (o.awayGoals ?? 0) + 1; g <= ag; g++) events.push({ type: 'goal', side: 'away', ...base });
    }

    if (o.status === 'LIVE' && m.status === 'FINISHED') events.push({ type: 'fulltime', matchId: m.id, home, away, homeGoals: hg, awayGoals: ag });
  }
  return events;
}

/** Tem jogo rolando ou começando agora? (aí vale atualizar mais vezes) */
export function isMatchTime(matches: Match[], now = Date.now()): boolean {
  return matches.some((m) => {
    if (m.status === 'LIVE') return true;
    if (m.status !== 'SCHEDULED') return false;
    const kickoff = Date.parse(m.utcDate);
    // Dos 5 minutos antes do início até 2h depois (a API às vezes demora a marcar "ao vivo")
    return now >= kickoff - 5 * 60_000 && now <= kickoff + 120 * 60_000;
  });
}
