// Modelo × casas de apostas: as cotações vêm da ESPN (a página de cada jogo já
// mostra). Nos jogos encerrados, compara quem acertou mais; nos próximos, mostra
// onde o modelo e o mercado discordam.
import { getMatchCenter } from './data/espn.ts';
import type { BacktestEntry, Outcome } from './model/backtest.ts';
import type { Prediction } from './model/prediction.ts';
import { isFinished } from './model/standings.ts';
import type { Match } from './types.ts';

export interface MarketOdds {
  provider: string;
  home: number;
  draw: number;
  away: number;
}

// Cotação de jogo encerrado não muda (e o resumo dele fica em disco): busca uma vez
const finishedOdds = new Map<number, MarketOdds | null>();
let loading: Promise<void> | null = null;
let progress = { loaded: 0, total: 0 };

async function oddsOf(m: Match): Promise<MarketOdds | null> {
  return (await getMatchCenter(m, 'bra.1'))?.odds ?? null;
}

/** Busca, em segundo plano e 3 por vez, as cotações dos jogos encerrados que faltam */
export function loadFinishedOdds(matches: Match[]): void {
  const finished = matches.filter(isFinished);
  const todo = finished.filter((m) => !finishedOdds.has(m.id));
  progress = { loaded: finished.length - todo.length, total: finished.length };
  if (!todo.length || loading) return;
  const queue = [...todo];
  loading = Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        try {
          finishedOdds.set(m.id, await oddsOf(m));
        } catch {
          // ESPN fora do ar: tenta de novo na próxima vez
        }
        progress.loaded++;
      }
    }),
  )
    .then(() => undefined)
    .finally(() => (loading = null));
}

export const marketProgress = () => ({ ...progress, ready: !loading && progress.loaded >= progress.total });

const probs = (o: { home: number; draw: number; away: number }): Record<Outcome, number> => ({ H: o.home, D: o.draw, A: o.away });
const brier = (p: Record<Outcome, number>, actual: Outcome) =>
  (['H', 'D', 'A'] as Outcome[]).reduce((s, k) => s + (p[k] - (k === actual ? 1 : 0)) ** 2, 0);
const favorite = (p: Record<Outcome, number>) => (['H', 'D', 'A'] as Outcome[]).reduce((a, b) => (p[b] > p[a] ? b : a));

/**
 * Nos jogos encerrados que têm cotação: nota de precisão (Brier) e acerto do
 * favorito, do modelo (a previsão feita antes do jogo, a mesma da aba Acertos) e do mercado.
 */
export function compareFinished(entries: BacktestEntry[]) {
  let n = 0;
  let modelBrier = 0;
  let marketBrier = 0;
  let modelHits = 0;
  let marketHits = 0;
  let modelBetter = 0;
  for (const e of entries) {
    const odds = finishedOdds.get(e.match.id);
    if (!odds) continue;
    const market = probs(odds);
    const mb = brier(market, e.actual);
    n++;
    modelBrier += e.brier;
    marketBrier += mb;
    if (e.hit) modelHits++;
    if (favorite(market) === e.actual) marketHits++;
    if (e.brier < mb) modelBetter++;
  }
  if (!n) return null;
  return {
    matches: n,
    provider: [...finishedOdds.values()].find((o) => o)?.provider ?? 'casas de apostas',
    model: { brier: modelBrier / n, accuracy: modelHits / n },
    market: { brier: marketBrier / n, accuracy: marketHits / n },
    /** Em quantos jogos a previsão do modelo foi mais precisa que a do mercado */
    modelBetter,
  };
}

/** Próximos jogos: chance pelo modelo e pelo mercado, e onde mais discordam */
export async function compareUpcoming(matches: { match: Match; model: Prediction }[]) {
  const rows = await Promise.all(
    matches.map(async ({ match, model }) => {
      const odds = await oddsOf(match).catch(() => null);
      if (!odds) return null;
      const mine = { H: model.pHome, D: model.pDraw, A: model.pAway };
      const market = probs(odds);
      // Resultado em que a diferença é maior (positivo: o modelo acredita mais que o mercado)
      const side = (['H', 'D', 'A'] as Outcome[]).reduce((a, b) => (Math.abs(mine[b] - market[b]) > Math.abs(mine[a] - market[a]) ? b : a));
      return { match, model: mine, market, provider: odds.provider, biggest: { side, diff: mine[side] - market[side] } };
    }),
  );
  return rows.filter((r) => r != null).sort((a, b) => Math.abs(b.biggest.diff) - Math.abs(a.biggest.diff));
}
