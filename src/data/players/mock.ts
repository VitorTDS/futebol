// Jogadores de EXEMPLO, sorteados, para o scout funcionar sem chave de API.
// Os nomes são genéricos ("FLA Atacante 1") de propósito: não são jogadores reais.
import { mulberry32, type Rng } from '../../model/random.ts';
import { CLUBS } from '../mock.ts';
import type { PlayerProvider, PlayerStats, Position } from '../../types.ts';

const MAX_MINUTES = 28 * 90;

/** Quantos jogadores de cada posição por elenco */
const SQUAD: [Position, number][] = [
  ['Goleiro', 2],
  ['Defensor', 7],
  ['Meio-campista', 7],
  ['Atacante', 5],
];

/** Médias por 90 minutos de um jogador "normal" de cada posição */
const RATES: Record<Position, Record<string, number>> = {
  Atacante: { goals: 0.42, assists: 0.15, shots: 2.8, keyPasses: 1.0, passes: 20, tackles: 0.5, interceptions: 0.2, blocks: 0.1, duels: 14, dribbles: 2.4 },
  'Meio-campista': { goals: 0.12, assists: 0.14, shots: 1.2, keyPasses: 1.4, passes: 45, tackles: 1.8, interceptions: 1.0, blocks: 0.3, duels: 11, dribbles: 1.5 },
  Defensor: { goals: 0.05, assists: 0.06, shots: 0.5, keyPasses: 0.4, passes: 45, tackles: 1.9, interceptions: 1.6, blocks: 0.8, duels: 9, dribbles: 0.5 },
  Goleiro: { goals: 0, assists: 0, shots: 0, keyPasses: 0.05, passes: 28, tackles: 0, interceptions: 0.1, blocks: 0, duels: 0.5, dribbles: 0 },
};

const between = (rng: Rng, lo: number, hi: number) => lo + (hi - lo) * rng();

function buildPlayers(): PlayerStats[] {
  const rng = mulberry32(71);
  const players: PlayerStats[] = [];

  CLUBS.forEach(([name, tla, strength], teamIndex) => {
    const team = { id: teamIndex + 1, name };
    for (const [position, count] of SQUAD) {
      for (let n = 1; n <= count; n++) {
        // Titulares jogam mais; o segundo goleiro quase não joga
        const starter = n <= (position === 'Goleiro' ? 1 : Math.ceil(count * 0.6));
        const minutes = Math.round(starter ? between(rng, 1500, MAX_MINUTES) : between(rng, 90, 1300));
        const quality = strength * between(rng, 0.75, 1.25);
        const rate = RATES[position];
        const total = (key: string, power = 1) =>
          Math.round(((rate[key] * quality ** power * minutes) / 90) * between(rng, 0.7, 1.3));

        const shots = total('shots', 1.2);
        const passes = total('passes', 0.5);
        const duels = total('duels', 0);
        const dribbles = total('dribbles', 1);
        const saves = position === 'Goleiro' ? Math.round(((2.8 * minutes) / 90) * between(rng, 0.7, 1.3) / strength) : 0;
        const conceded = position === 'Goleiro' ? Math.round(((1.25 * minutes) / 90) * between(rng, 0.7, 1.3) / quality) : 0;

        players.push({
          id: players.length + 1,
          name: `${tla} ${position} ${n}`,
          age: Math.round(between(rng, 19, 34)),
          nationality: 'Brasil',
          team,
          position,
          appearances: Math.max(1, Math.round((minutes / 90) * between(rng, 1, 1.25))),
          minutes,
          rating: Math.round((6.6 + (quality - 1) * 1.2 + between(rng, -0.25, 0.25)) * 100) / 100,
          goals: total('goals', 1.5),
          assists: total('assists', 1.5),
          shots,
          shotsOnTarget: Math.round(shots * between(rng, 0.25, 0.5) * Math.min(1.3, quality)),
          passes,
          keyPasses: total('keyPasses', 1.3),
          passAccuracy: Math.round(Math.min(95, (position === 'Atacante' ? 72 : position === 'Goleiro' ? 70 : 84) * quality ** 0.15 + between(rng, -4, 4))),
          tackles: total('tackles', 0.5),
          interceptions: total('interceptions', 0.5),
          blocks: total('blocks', 0.5),
          duels,
          duelsWon: Math.round(duels * Math.min(0.75, between(rng, 0.38, 0.6) * quality ** 0.3)),
          dribbles,
          dribblesWon: Math.round(dribbles * between(rng, 0.35, 0.65)),
          saves,
          conceded,
        });
      }
    }
  });

  return players;
}

export function createMockPlayerProvider(): PlayerProvider {
  const players = buildPlayers();
  return {
    name: 'jogadores de exemplo',
    status: () => ({ ready: true, loaded: players.length, total: players.length, error: null }),
    getPlayers: async () => players,
  };
}
