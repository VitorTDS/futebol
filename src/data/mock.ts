// Dados de EXEMPLO: um campeonato fictício com 20 clubes, usado quando não há
// token da football-data.org. Os resultados são sorteados, não são reais.
import { mulberry32, samplePoisson } from '../model/random.ts';
import type { DataProvider, Match, Team } from '../types.ts';

export const CLUBS: [string, string, number][] = [
  // nome, sigla, força (usada só para sortear os resultados)
  ['Flamengo', 'FLA', 1.35],
  ['Palmeiras', 'PAL', 1.3],
  ['Cruzeiro', 'CRU', 1.15],
  ['Mirassol', 'MIR', 1.05],
  ['Fluminense', 'FLU', 1.05],
  ['Botafogo', 'BOT', 1.1],
  ['Bahia', 'BAH', 1.0],
  ['São Paulo', 'SAO', 1.0],
  ['Grêmio', 'GRE', 0.95],
  ['Bragantino', 'RBB', 0.95],
  ['Atlético-MG', 'CAM', 0.95],
  ['Santos', 'SAN', 0.9],
  ['Corinthians', 'COR', 0.95],
  ['Vasco da Gama', 'VAS', 0.9],
  ['Vitória', 'VIT', 0.85],
  ['Internacional', 'INT', 0.9],
  ['Coritiba', 'CFC', 0.85],
  ['Athletico-PR', 'CAP', 0.85],
  ['Chapecoense', 'CHA', 0.75],
  ['Remo', 'REM', 0.75],
];

/** Clubes que caíram na temporada anterior de exemplo (os 4 últimos de CLUBS subiram no lugar deles) */
const RELEGATED_LAST_SEASON: [string, string, number][] = [
  ['Fortaleza', 'FOR', 0.85],
  ['Ceará', 'CEA', 0.85],
  ['Juventude', 'JUV', 0.8],
  ['Sport', 'SPT', 0.75],
];
const PROMOTED_THIS_SEASON = 4;

const FINISHED_ROUNDS = 28;
const DAY_MS = 86_400_000;

interface Club {
  team: Team;
  strength: number;
}

function buildSeason(clubs: Club[], opts: { seed: number; idOffset: number; dayOffset: number; finishedRounds: number; live: boolean }): Match[] {
  const rng = mulberry32(opts.seed);
  const n = clubs.length;

  // Turno pelo "método do círculo"; o returno inverte o mando.
  const rotation = clubs.map((_, i) => i);
  const firstHalf: [number, number][][] = [];
  for (let r = 0; r < n - 1; r++) {
    const round: [number, number][] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = rotation[i];
      const b = rotation[n - 1 - i];
      round.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    firstHalf.push(round);
    rotation.splice(1, 0, rotation.pop()!);
  }
  const rounds = [...firstHalf, ...firstHalf.map((round) => round.map(([h, a]): [number, number] => [a, h]))];

  // Na temporada atual, a rodada FINISHED_ROUNDS + 1 acontece hoje.
  const today = new Date();
  today.setUTCHours(22, 0, 0, 0);

  const matches: Match[] = [];
  rounds.forEach((round, r) => {
    const matchday = r + 1;
    const date = new Date(today.getTime() + ((matchday - FINISHED_ROUNDS - 1) * 4 + opts.dayOffset) * DAY_MS);

    round.forEach(([h, a], i) => {
      let status: Match['status'] = 'SCHEDULED';
      let homeGoals: number | null = null;
      let awayGoals: number | null = null;
      let minute: number | null = null;

      const lh = (1.45 * clubs[h].strength) / clubs[a].strength;
      const la = (1.1 * clubs[a].strength) / clubs[h].strength;
      const hg = samplePoisson(lh, rng);
      const ag = samplePoisson(la, rng);

      if (matchday <= opts.finishedRounds) {
        status = 'FINISHED';
        homeGoals = hg;
        awayGoals = ag;
      } else if (opts.live && matchday === opts.finishedRounds + 1 && i < 2) {
        // Dois jogos "ao vivo" para testar o modo ao vivo
        status = 'LIVE';
        minute = i === 0 ? 63 : 27;
        homeGoals = Math.min(hg, i === 0 ? 2 : 1);
        awayGoals = Math.min(ag, 1);
      }

      matches.push({
        id: opts.idOffset + matchday * 100 + i,
        matchday,
        utcDate: new Date(date.getTime() + (i % 3) * 2 * 3_600_000).toISOString(),
        status,
        home: clubs[h].team,
        away: clubs[a].team,
        homeGoals,
        awayGoals,
        minute,
      });
    });
  });

  return matches;
}

const currentClubs = (): Club[] =>
  CLUBS.map(([name, tla, strength], i) => ({ team: { id: i + 1, name, shortName: name, tla }, strength }));

function buildMatches(): Match[] {
  return buildSeason(currentClubs(), { seed: 2026, idOffset: 0, dayOffset: 0, finishedRounds: FINISHED_ROUNDS, live: true });
}

/** Temporada anterior completa, um ano antes, com as forças um pouco diferentes. */
function buildPreviousSeason(): Match[] {
  const rng = mulberry32(2025);
  const stayed = currentClubs().slice(0, CLUBS.length - PROMOTED_THIS_SEASON);
  const relegated = RELEGATED_LAST_SEASON.map(([name, tla, strength], i) => ({
    team: { id: CLUBS.length + i + 1, name, shortName: name, tla },
    strength,
  }));
  const clubs = [...stayed, ...relegated].map((c) => ({ ...c, strength: c.strength * (0.88 + 0.24 * rng()) }));
  return buildSeason(clubs, { seed: 2025, idOffset: 10_000, dayOffset: -364, finishedRounds: 38, live: false });
}

export function createMockProvider(): DataProvider {
  const matches = buildMatches();
  const previous = buildPreviousSeason();
  return {
    name: 'dados de exemplo',
    getMatches: async () => matches,
    getScorers: async () => null,
    getPreviousSeasons: async (count) => (count > 0 ? [{ season: 'temporada anterior (exemplo)', matches: previous }] : []),
  };
}
