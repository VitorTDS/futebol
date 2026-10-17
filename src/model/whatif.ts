// Simulador "e se": o usuário escolhe o resultado de jogos que ainda não aconteceram.
import { isFinished } from './standings.ts';
import type { Match } from '../types.ts';

export type Pick = 'H' | 'D' | 'A';

/** Transforma o palpite num placar final (respeitando o placar atual de jogo ao vivo). */
export function applyPick(m: Match, pick: Pick): Match {
  const hg = m.homeGoals ?? 0;
  const ag = m.awayGoals ?? 0;
  const [h, a] =
    pick === 'H' ? [Math.max(hg, ag + 1), ag] : pick === 'A' ? [hg, Math.max(ag, hg + 1)] : [Math.max(hg, ag), Math.max(hg, ag)];
  return { ...m, status: 'FINISHED', homeGoals: h, awayGoals: a, minute: null };
}

/**
 * Placar final de cada jogo com palpite (por id), só para jogos que ainda não
 * terminaram; palpites inválidos são ignorados.
 */
export function pickedScores(matches: Match[], picks: Record<string, unknown>): Map<number, [number, number]> {
  const scores = new Map<number, [number, number]>();
  for (const m of matches) {
    const p = picks[m.id];
    if (isFinished(m) || (p !== 'H' && p !== 'D' && p !== 'A')) continue;
    const r = applyPick(m, p);
    scores.set(m.id, [r.homeGoals!, r.awayGoals!]);
  }
  return scores;
}
