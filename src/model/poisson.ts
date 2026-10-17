// Modelo de Poisson simples: cada time tem uma força de ataque e de defesa calculada
// a partir dos gols marcados/sofridos. Gols esperados de um jogo =
// ataque do time × defesa do adversário × média de gols da liga (mandante ou visitante).
import type { FittedModel } from './prediction.ts';
import { isFinished } from './standings.ts';
import type { Match, Team } from '../types.ts';

/** "Jogos fictícios" na média da liga somados a cada time: evita exageros no começo do campeonato. */
const PRIOR_GAMES = 5;

export function fitPoisson(teams: Team[], matches: Match[]): FittedModel {
  const finished = matches.filter(isFinished);
  let homeGoals = 0;
  let awayGoals = 0;
  const gf = new Map<number, number>();
  const ga = new Map<number, number>();
  const games = new Map<number, number>();
  const add = (map: Map<number, number>, id: number, v: number) => map.set(id, (map.get(id) ?? 0) + v);

  for (const m of finished) {
    homeGoals += m.homeGoals;
    awayGoals += m.awayGoals;
    add(gf, m.home.id, m.homeGoals);
    add(ga, m.home.id, m.awayGoals);
    add(gf, m.away.id, m.awayGoals);
    add(ga, m.away.id, m.homeGoals);
    add(games, m.home.id, 1);
    add(games, m.away.id, 1);
  }

  const n = finished.length;
  const homeAvg = n ? homeGoals / n : 1.4;
  const awayAvg = n ? awayGoals / n : 1.1;
  const teamAvg = (homeAvg + awayAvg) / 2;

  const attack = new Map<number, number>();
  const defense = new Map<number, number>();
  for (const t of teams) {
    const g = games.get(t.id) ?? 0;
    attack.set(t.id, ((gf.get(t.id) ?? 0) + PRIOR_GAMES * teamAvg) / (g + PRIOR_GAMES) / teamAvg);
    defense.set(t.id, ((ga.get(t.id) ?? 0) + PRIOR_GAMES * teamAvg) / (g + PRIOR_GAMES) / teamAvg);
  }

  return {
    kind: 'poisson',
    rho: 0,
    expectedGoals: (homeId, awayId) => ({
      home: (attack.get(homeId) ?? 1) * (defense.get(awayId) ?? 1) * homeAvg,
      away: (attack.get(awayId) ?? 1) * (defense.get(homeId) ?? 1) * awayAvg,
    }),
  };
}
