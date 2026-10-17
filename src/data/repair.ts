// A lista completa da football-data às vezes "desfaz" por um tempo jogos já
// encerrados (volta a mostrá-los como agendados ou ao vivo, sem placar).
// Estas funções protegem o painel disso.
import type { Match } from '../types.ts';

/** Jogo começou há mais tempo que isso e ainda não terminou? Algo está errado. */
const STALE_AFTER_MS = 4 * 3_600_000;

/**
 * Lembra os jogos encerrados e não deixa um deles "voltar" a ficar sem resultado.
 * `memory` é atualizada com os encerrados novos; `learned` diz se mudou.
 */
export function keepFinished(matches: Match[], memory: Map<number, Match>): { matches: Match[]; learned: boolean } {
  let learned = false;
  const out = matches.map((m) => {
    if (m.status === 'FINISHED') {
      const known = memory.get(m.id);
      if (!known || known.homeGoals !== m.homeGoals || known.awayGoals !== m.awayGoals) {
        memory.set(m.id, m);
        learned = true;
      }
      return m;
    }
    return memory.get(m.id) ?? m;
  });
  return { matches: out, learned };
}

/**
 * Rodadas com jogo que já devia ter acabado e aparece sem resultado (fora os
 * adiados/cancelados, em `inactive`). Essas rodadas valem ser buscadas de novo.
 */
export function staleMatchdays(matches: Match[], inactive: Set<number>, now = Date.now()): number[] {
  const rounds = new Set<number>();
  for (const m of matches) {
    // matchday 0 = jogo de mata-mata (sem rodada): não dá para rebuscar por rodada
    if (m.status === 'FINISHED' || inactive.has(m.id) || !m.matchday) continue;
    if (Date.parse(m.utcDate) < now - STALE_AFTER_MS) rounds.add(m.matchday);
  }
  return [...rounds].sort((a, b) => a - b);
}
