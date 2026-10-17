// Scout: transforma os totais da temporada em métricas comparáveis (por 90
// minutos ou em %), calcula o percentil de cada jogador entre os da mesma
// posição e encontra jogadores com perfil parecido.
import type { PlayerStats, Position } from '../types.ts';

export interface MetricDef {
  key: string;
  label: string;
  /** Texto curto para o gráfico de radar */
  short: string;
  format: 'per90' | 'pct' | 'rating';
  /** Para métricas em que menos é melhor (ex.: gols sofridos) */
  lowerIsBetter?: boolean;
  value(p: PlayerStats): number | null;
}

const per90 = (get: (p: PlayerStats) => number) => (p: PlayerStats) => (p.minutes > 0 ? (get(p) * 90) / p.minutes : null);
const ratio = (num: (p: PlayerStats) => number, den: (p: PlayerStats) => number) => (p: PlayerStats) =>
  den(p) > 0 ? (num(p) / den(p)) * 100 : null;

export const METRICS: Record<string, MetricDef> = Object.fromEntries(
  (
    [
      { key: 'goals', label: 'Gols por 90 min', short: 'Gols', format: 'per90', value: per90((p) => p.goals) },
      { key: 'assists', label: 'Assistências por 90 min', short: 'Assistências', format: 'per90', value: per90((p) => p.assists) },
      { key: 'shots', label: 'Finalizações por 90 min', short: 'Finalizações', format: 'per90', value: per90((p) => p.shots) },
      { key: 'shotAccuracy', label: 'Finalizações no alvo', short: 'Fin. no alvo', format: 'pct', value: ratio((p) => p.shotsOnTarget, (p) => p.shots) },
      { key: 'keyPasses', label: 'Passes decisivos por 90 min', short: 'Passes decisivos', format: 'per90', value: per90((p) => p.keyPasses) },
      { key: 'passes', label: 'Passes por 90 min', short: 'Passes', format: 'per90', value: per90((p) => p.passes) },
      { key: 'passAccuracy', label: 'Precisão de passe', short: 'Precisão passe', format: 'pct', value: (p) => p.passAccuracy },
      { key: 'dribbles', label: 'Dribles certos por 90 min', short: 'Dribles', format: 'per90', value: per90((p) => p.dribblesWon) },
      { key: 'tackles', label: 'Desarmes por 90 min', short: 'Desarmes', format: 'per90', value: per90((p) => p.tackles) },
      { key: 'interceptions', label: 'Interceptações por 90 min', short: 'Interceptações', format: 'per90', value: per90((p) => p.interceptions) },
      { key: 'blocks', label: 'Bloqueios por 90 min', short: 'Bloqueios', format: 'per90', value: per90((p) => p.blocks) },
      { key: 'duelsWon', label: 'Duelos ganhos', short: 'Duelos ganhos', format: 'pct', value: ratio((p) => p.duelsWon, (p) => p.duels) },
      { key: 'saves', label: 'Defesas por 90 min', short: 'Defesas', format: 'per90', value: per90((p) => p.saves) },
      { key: 'savePct', label: 'Aproveitamento de defesas', short: '% defesas', format: 'pct', value: ratio((p) => p.saves, (p) => p.saves + p.conceded) },
      { key: 'conceded', label: 'Gols sofridos por 90 min', short: 'Gols sofridos', format: 'per90', lowerIsBetter: true, value: per90((p) => p.conceded) },
      { key: 'rating', label: 'Nota média', short: 'Nota', format: 'rating', value: (p) => p.rating },
    ] satisfies MetricDef[]
  ).map((m) => [m.key, m]),
);

/** O que importa avaliar em cada posição (cada uma vira um eixo do radar) */
export const POSITION_METRICS: Record<Position, string[]> = {
  Atacante: ['goals', 'shots', 'shotAccuracy', 'assists', 'keyPasses', 'dribbles', 'duelsWon', 'rating'],
  'Meio-campista': ['keyPasses', 'assists', 'passes', 'passAccuracy', 'dribbles', 'tackles', 'interceptions', 'goals'],
  Defensor: ['tackles', 'interceptions', 'blocks', 'duelsWon', 'passes', 'passAccuracy', 'keyPasses', 'rating'],
  Goleiro: ['saves', 'savePct', 'conceded', 'passes', 'passAccuracy', 'rating'],
};

/** Métricas que aparecem na lista de jogadores (filtro "todas as posições" usa as de Atacante/Meia) */
export const LIST_METRICS: Record<Position | 'all', string[]> = {
  all: ['goals', 'assists', 'keyPasses', 'rating'],
  Atacante: ['goals', 'shots', 'assists', 'rating'],
  'Meio-campista': ['keyPasses', 'assists', 'passAccuracy', 'tackles'],
  Defensor: ['tackles', 'interceptions', 'duelsWon', 'rating'],
  Goleiro: ['saves', 'savePct', 'conceded', 'rating'],
};

export interface MetricValue {
  key: string;
  label: string;
  short: string;
  format: MetricDef['format'];
  lowerIsBetter: boolean;
  value: number | null;
  /** 0–100: porcentagem dos jogadores da mesma posição que ele supera (já invertido quando menos é melhor) */
  percentile: number | null;
}

export class ScoutIndex {
  readonly players: PlayerStats[];
  readonly minMinutes: number;
  private byId: Map<number, PlayerStats>;
  /** Valores ordenados de cada métrica, por posição, só de quem tem minutos suficientes */
  private pools = new Map<string, number[]>();

  constructor(players: PlayerStats[], minMinutes: number) {
    this.players = players;
    this.minMinutes = minMinutes;
    this.byId = new Map(players.map((p) => [p.id, p]));
    for (const p of players) {
      if (p.minutes < minMinutes) continue;
      for (const key of Object.keys(METRICS)) {
        const v = METRICS[key].value(p);
        if (v == null) continue;
        const poolKey = `${p.position}:${key}`;
        if (!this.pools.has(poolKey)) this.pools.set(poolKey, []);
        this.pools.get(poolKey)!.push(v);
      }
    }
    for (const values of this.pools.values()) values.sort((a, b) => a - b);
  }

  get(id: number) {
    return this.byId.get(id);
  }

  /** Tamanho do grupo de comparação de uma posição */
  poolSize(position: Position): number {
    return this.players.filter((p) => p.position === position && p.minutes >= this.minMinutes).length;
  }

  percentile(p: PlayerStats, key: string): number | null {
    const def = METRICS[key];
    const v = def.value(p);
    const pool = this.pools.get(`${p.position}:${key}`);
    if (v == null || !pool?.length) return null;
    // Quantos têm valor menor + metade dos empatados
    let below = 0;
    let equal = 0;
    for (const x of pool) {
      if (x < v) below++;
      else if (x === v) equal++;
    }
    const pct = ((below + equal / 2) / pool.length) * 100;
    return def.lowerIsBetter ? 100 - pct : pct;
  }

  metrics(p: PlayerStats, keys = POSITION_METRICS[p.position]): MetricValue[] {
    return keys.map((key) => {
      const def = METRICS[key];
      return {
        key,
        label: def.label,
        short: def.short,
        format: def.format,
        lowerIsBetter: !!def.lowerIsBetter,
        value: def.value(p),
        percentile: this.percentile(p, key),
      };
    });
  }

  /**
   * Jogadores com perfil parecido: mesma posição, minutos suficientes, menor
   * distância entre os percentis das métricas da posição.
   */
  similar(p: PlayerStats, limit = 5) {
    const keys = POSITION_METRICS[p.position];
    const vector = (x: PlayerStats) => keys.map((k) => this.percentile(x, k) ?? 50);
    const target = vector(p);
    const maxDistance = 100 * Math.sqrt(keys.length);

    return this.players
      .filter((x) => x.id !== p.id && x.position === p.position && x.minutes >= this.minMinutes)
      .map((x) => {
        const v = vector(x);
        const distance = Math.sqrt(v.reduce((s, vi, i) => s + (vi - target[i]) ** 2, 0));
        return { player: x, similarity: 1 - distance / maxDistance };
      })
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }
}
