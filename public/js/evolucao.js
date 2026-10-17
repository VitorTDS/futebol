// ---------- Evolução ----------

// Clubes com a mesma cor (seis são pretos, vários vermelhos): cada um ganha um tipo de linha
const LINE_DASHES = [[], [8, 4], [2, 4], [12, 4, 2, 4], [4, 4], [1, 3], [16, 6]];

/** Escudo do clube, para desenhar na ponta da linha do gráfico */
function crestPoint(team, onLoad) {
  if (!team.crest) return 'circle';
  const img = new Image(20, 20);
  img.onload = onLoad;
  img.src = team.crest;
  return img;
}

/** Tema escuro ligado agora (pelo botão ou pelo celular) */
const darkTheme = () => getComputedStyle(document.documentElement).colorScheme === 'dark';

/**
 * No tema escuro: clube preto vira cinza-claro (some no fundo) e as cores escuras
 * (vinho, verde-escuro) clareiam um pouco, mantendo o tom do clube.
 */
function lineColor(color) {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex || !darkTheme()) return color;
  const n = parseInt(hex, 16);
  const rgb = [n >> 16, (n >> 8) & 255, n & 255];
  if (Math.max(...rgb) < 60) return '#cfd6cf';
  const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  if (lum >= 90) return color;
  const [r, g, b] = rgb.map((c) => Math.round(c + (255 - c) * 0.35));
  return `rgb(${r}, ${g}, ${b})`;
}

// Cor e tipo de linha de cada clube (os dois gráficos da aba usam os mesmos)
state.teamStyle = new Map();

async function loadEvolution() {
  const data = await api('/api/evolution');
  const n = data.teams.length;
  const sameColor = new Map();
  const datasets = data.teams.map((t, i) => {
    const color = lineColor(t.color ?? `hsl(${(i * 360) / n}, 70%, 40%)`);
    const k = sameColor.get(color) ?? 0;
    sameColor.set(color, k + 1);
    state.teamStyle.set(t.team.id, { color, dash: LINE_DASHES[k % LINE_DASHES.length] });
    // Último ponto com dado: é onde fica o escudo
    const last = t.positions.findLastIndex((p) => p != null);
    const crest = crestPoint(t.team, () => state.evolutionChart?.update('none'));
    return {
      label: t.team.shortName,
      data: t.positions,
      borderColor: color,
      backgroundColor: color,
      borderDash: LINE_DASHES[k % LINE_DASHES.length],
      borderWidth: 2.5,
      hidden: i >= 6,
      tension: 0.25,
      pointStyle: (ctx) => (ctx.dataIndex === last ? crest : 'circle'),
      pointRadius: (ctx) => (ctx.dataIndex === last ? 10 : 2),
      pointHoverRadius: (ctx) => (ctx.dataIndex === last ? 12 : 4),
    };
  });

  // As chances usam as mesmas cores: carregam depois de definir o estilo de cada clube
  loadChances().catch((err) => showBanner(`Não foi possível carregar as chances: ${err.message}`, true));

  if (state.evolutionChart) {
    state.evolutionChart.data.labels = data.matchdays;
    // Atualiza dados e estilo de cada time (pelo nome: a ordem da tabela muda), mas
    // mantém quais times estão visíveis
    const byLabel = new Map(datasets.map((d) => [d.label, d]));
    state.evolutionChart.data.datasets.forEach((ds) => {
      const next = byLabel.get(ds.label);
      if (next) Object.assign(ds, { ...next, hidden: ds.hidden });
    });
    state.evolutionChart.update();
    return;
  }

  state.evolutionChart = new Chart($('#evolution-chart'), {
    type: 'line',
    data: { labels: data.matchdays, datasets },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        y: { reverse: true, min: 1, max: n, ticks: { stepSize: 1 }, title: { display: true, text: 'Posição' } },
        x: { title: { display: true, text: 'Rodada' } },
      },
      // Legenda como amostra da linha (cor e tracejado de cada time)
      plugins: { legend: { position: 'right', labels: { boxWidth: 28, boxHeight: 3 } } },
    },
  });
}

// ---------- Chances rodada a rodada ----------

state.chancesMetric = 'title';
const CHANCE_LABEL = { title: 'título', libertadores: 'G5 (Libertadores pela tabela)', relegation: 'rebaixamento' };

async function loadChances() {
  const data = await api('/api/chances');
  const metric = state.chancesMetric;
  // Começam visíveis os 6 com mais chance hoje
  const now = (t) => t[metric].at(-1) ?? 0;
  const top = new Set([...data.teams].sort((a, b) => now(b) - now(a)).slice(0, 6).map((t) => t.team.id));
  const datasets = data.teams.map((t, i) => {
    const style = state.teamStyle.get(t.team.id) ?? { color: `hsl(${(i * 360) / data.teams.length}, 70%, 40%)`, dash: [] };
    const last = t[metric].length - 1;
    const crest = crestPoint(t.team, () => state.charts?.chances?.update('none'));
    return {
      label: t.team.shortName,
      data: t[metric].map((p) => Math.round(p * 1000) / 10),
      borderColor: style.color,
      backgroundColor: style.color,
      borderDash: style.dash,
      borderWidth: 2.5,
      hidden: !top.has(t.team.id),
      tension: 0.25,
      pointStyle: (ctx) => (ctx.dataIndex === last ? crest : 'circle'),
      pointRadius: (ctx) => (ctx.dataIndex === last ? 10 : 1.5),
    };
  });
  upsertChart('chances', $('#chances-chart'), {
    type: 'line',
    data: { labels: data.rounds.map((r) => (r === 0 ? 'início' : r)), datasets },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        y: { min: 0, max: 100, ticks: { callback: (v) => `${v}%` }, title: { display: true, text: `Chance de ${CHANCE_LABEL[metric]}` } },
        x: { title: { display: true, text: 'Rodada' } },
      },
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 28, boxHeight: 3 } },
        tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${String(item.raw).replace('.', ',')}%` } },
      },
    },
  });
}

$('#chances-metric').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-m]');
  if (!b) return;
  state.chancesMetric = b.dataset.m;
  document.querySelectorAll('#chances-metric button').forEach((x) => x.classList.toggle('on', x === b));
  // Troca de métrica: refaz do zero (os visíveis mudam)
  state.charts?.chances?.destroy();
  if (state.charts) delete state.charts.chances;
  loadChances().catch((err) => showBanner(err.message, true));
});
