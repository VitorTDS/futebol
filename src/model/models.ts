import { config } from '../config.ts';
import { fitDixonColes } from './dixonColes.ts';
import { fitPoisson } from './poisson.ts';
import type { FittedModel, ModelKind } from './prediction.ts';
import { computeStandings, isFinished, teamsFrom } from './standings.ts';
import { ratings } from './teamProfile.ts';
import type { Match, Team } from '../types.ts';

export const MODEL_KINDS: ModelKind[] = ['poisson', 'dixon-coles'];

/**
 * O que se sabe das temporadas anteriores. O Dixon-Coles usa esses jogos junto
 * com os da temporada atual (pesando menos, pelo TIME_DECAY), o que ajuda muito
 * no começo do campeonato, quando há poucos jogos.
 */
export interface Background {
  seasons: string[];
  matches: Match[];
  teams: Team[];
  /** Times da temporada atual que não jogaram as anteriores (subiram da Série B) */
  newTeams: Team[];
  /** Ponto de partida de quem subiu: a força média de quem caiu na última temporada */
  newTeamPrior: { attack: number; defense: number } | null;
}

export function buildBackground(currentTeams: Team[], seasons: { season: string; matches: Match[] }[]): Background | null {
  const withGames = seasons.filter((s) => s.matches.some(isFinished));
  if (!withGames.length) return null;

  const matches = withGames.flatMap((s) => s.matches.filter(isFinished));
  const teams = teamsFrom(matches);
  const known = new Set(teams.map((t) => t.id));
  const newTeams = currentTeams.filter((t) => !known.has(t.id));

  // Quem caiu na temporada mais recente: força média segundo o modelo daquela temporada
  const last = withGames[0].matches.filter(isFinished);
  const lastTeams = teamsFrom(last);
  const lastDate = last.reduce((max, m) => (m.utcDate > max ? m.utcDate : max), '');
  const lastModel = fitDixonColes(lastTeams, last, { asOf: lastDate, timeDecay: 0 });
  const lastRatings = ratings(lastModel, lastTeams);
  const relegated = computeStandings(lastTeams, last).slice(-config.zones.relegation);
  const avg = (key: 'attack' | 'defense') =>
    relegated.reduce((sum, row) => sum + lastRatings.get(row.team.id)![key], 0) / relegated.length;

  return {
    seasons: withGames.map((s) => s.season),
    matches,
    teams,
    newTeams,
    newTeamPrior: relegated.length ? { attack: avg('attack'), defense: avg('defense') } : null,
  };
}

/**
 * Ajusta o modelo escolhido com os jogos encerrados, como se hoje fosse `asOf`.
 * O Poisson simples ignora `background`: ele é a referência "sem nada a mais".
 */
export function fitModel(
  kind: ModelKind,
  teams: Team[],
  matches: Match[],
  asOf: string,
  timeDecay: number,
  background?: Background | null,
): FittedModel {
  if (kind !== 'dixon-coles') return fitPoisson(teams, matches);
  if (!background) return fitDixonColes(teams, matches, { asOf, timeDecay });

  // Times atuais + quem só aparece nas temporadas anteriores
  const allTeams = [...new Map([...background.teams, ...teams].map((t) => [t.id, t])).values()];
  const prior = background.newTeamPrior;
  return fitDixonColes(allTeams, [...background.matches, ...matches], {
    asOf,
    timeDecay,
    priors: prior ? new Map(background.newTeams.map((t) => [t.id, prior])) : undefined,
  });
}
