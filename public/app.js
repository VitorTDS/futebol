const REFRESH_MS = 60_000;

const state = {
  tab: 'tabela',
  matchday: null,
  totalMatchdays: 38,
  evolutionChart: null,
  history: { matchday: null, first: 1, last: 1, accuracyChart: null, calibrationChart: null },
};

Chart.defaults.color = '#6b6a5c';
Chart.defaults.borderColor = '#e2dccb';
Chart.defaults.font.family = 'Archivo, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const $ = (sel) => document.querySelector(sel);

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path) {
  const res = await fetch(path);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Erro ${res.status}`);
  return body;
}

function pct(p) {
  if (p == null) return '–';
  if (p === 0) return '–';
  if (p < 0.001) return '<0,1%';
  if (p > 0.999 && p < 1) return '>99,9%';
  return (p * 100).toLocaleString('pt-BR', { maximumFractionDigits: p < 0.1 ? 1 : 0 }) + '%';
}

function teamHtml(team, { short = false } = {}) {
  const icon = team.crest
    ? `<img class="crest" src="${escapeHtml(team.crest)}" alt="" loading="lazy" />`
    : `<span class="badge">${escapeHtml(team.tla)}</span>`;
  return `<a class="team" href="#/time/${team.id}">${icon}<span>${escapeHtml(short ? team.tla : team.shortName)}</span></a>`;
}

function probCell(p, color) {
  return `<td class="prob"><span class="prob-cell"><span class="mini"><div data-w="${p}" style="background:${color}"></div></span><small>${pct(p)}</small></span></td>`;
}

// Barras com data-w (0 a 1) crescem até a largura certa no próximo quadro.
function growBars(root = document) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      root.querySelectorAll('[data-w]').forEach((el) => (el.style.width = `${Math.max(0, +el.dataset.w) * 100}%`)),
    ),
  );
}

// Anima um número de 0 até o valor final.
function countUp(el, target, ms = 900) {
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    el.textContent = Math.round(target * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function probBar(p, cls = '') {
  return `<div class="probbar ${cls}" title="Vitória mandante / empate / vitória visitante">
    <div class="h" data-w="${p.pHome}"></div><div class="d" data-w="${p.pDraw}"></div><div class="a" data-w="${p.pAway}"></div>
  </div>`;
}

function crestImg(team) {
  return team.crest
    ? `<img src="${escapeHtml(team.crest)}" alt="" loading="lazy" />`
    : `<span class="badge">${escapeHtml(team.tla)}</span>`;
}

function showBanner(text, isError = false) {
  const el = $('#banner');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('error', isError);
}

// ---------- Classificação ----------

// Linha de informações no topo; aparece em qualquer aba.
function setMeta(data) {
  const updated = new Date(data.updatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const bg = data.background;
  const bgText = bg.enabled && bg.seasons.length ? ` + ${bg.seasons.join(', ')}` : '';
  $('#meta').textContent = `Rodada ${data.currentMatchday} de ${data.totalMatchdays} · fonte: ${data.source} · modelo: ${data.model}${bgText} · atualizado às ${updated}`;
  state.metaSet = true;
}

async function loadOverview() {
  const data = await api('/api/overview');
  const { zones, standings } = data;
  const total = standings.length;
  const bg = data.background;

  setMeta(data);
  $('#sim-note').textContent = `· probabilidades a partir de ${data.simulations.toLocaleString('pt-BR')} simulações do restante do campeonato`;

  const notices = [];
  if (data.source === 'dados de exemplo') {
    notices.push('Você está vendo dados de exemplo (resultados sorteados). Configure o FOOTBALL_DATA_TOKEN no arquivo .env para usar o Brasileirão de verdade.');
  }
  if (bg.enabled && bg.error) {
    notices.push(`Não foi possível carregar a temporada anterior (${bg.error}). As previsões usam só a temporada atual.`);
  }
  showBanner(notices.join(' '));

  state.totalMatchdays = data.totalMatchdays;
  if (state.matchday == null) state.matchday = data.currentMatchday;

  const zoneClass = (pos) =>
    pos <= zones.libertadores ? 'lib' : pos <= zones.sulamericana ? 'sul' : pos > total - zones.relegation ? 'reb' : '';

  $('#standings-body').innerHTML = standings
    .map((row) => {
      const o = row.outlook;
      return `<tr class="${zoneClass(row.position)}">
        <td class="pos">${row.position}</td>
        <td class="left">${teamHtml(row.team)}</td>
        <td class="points" data-n="${row.points}">${row.points}</td>
        <td>${row.played}</td>
        <td>${row.won}</td>
        <td>${row.drawn}</td>
        <td>${row.lost}</td>
        <td>${row.goalDiff > 0 ? '+' : ''}${row.goalDiff}</td>
        <td class="hide-sm"><span class="form">${row.form.map((r) => `<span class="${r}">${r}</span>`).join('')}</span></td>
        <td class="prob num">${o.expectedPoints.toFixed(1).replace('.', ',')}</td>
        ${probCell(o.title, 'var(--titulo)')}
        ${probCell(o.libertadores, 'var(--lib)')}
        ${probCell(o.relegation, 'var(--reb)')}
      </tr>`;
    })
    .join('');

  // Na primeira vez os pontos sobem do zero; nas atualizações seguintes não pisca.
  if (!state.standingsAnimated) {
    state.standingsAnimated = true;
    document.querySelectorAll('#standings-body td.points').forEach((td) => countUp(td, +td.dataset.n));
  }

  renderRace(standings);
  growBars($('#tabela'));
  await loadStrip();
}

const RACES = { title: 'var(--titulo)', libertadores: 'var(--lib)', relegation: 'var(--reb)' };

function renderRace(standings) {
  for (const [key, color] of Object.entries(RACES)) {
    const top = standings
      .filter((r) => r.outlook[key] > 0)
      .sort((a, b) => b.outlook[key] - a.outlook[key])
      .slice(0, 6);
    $(`#corrida-${key}`).innerHTML = top.length
      ? top
          .map(
            (r) => `<a class="linha" href="#/time/${r.team.id}">${crestImg(r.team)}
          <div class="trilho" style="--c:${color}"><div data-w="${r.outlook[key]}"></div><span>${escapeHtml(r.team.shortName)}</span></div>
          <b>${pct(r.outlook[key])}</b></a>`,
          )
          .join('')
      : '<p class="muted">Ninguém tem chance.</p>';
  }
}

// Faixa com os jogos da rodada atual, na aba Classificação
async function loadStrip() {
  const data = await api('/api/matches');
  $('#faixa').innerHTML = data.matches
    .map((m, i) => {
      const live = m.status === 'LIVE';
      const finished = m.status === 'FINISHED';
      const date = new Date(m.utcDate);
      const when = date.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
      const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const p = m.prediction;
      return `<a class="jogo ${live ? 'live' : ''}" href="#/jogos" style="animation-delay:${i * 50}ms">
        <header><span>${live ? `<span class="live-tag">● ${m.minute ?? ''}'</span>` : finished ? 'Encerrado' : when}</span><span>${time}</span></header>
        <div class="vs">
          <div>${crestImg(m.home)}${escapeHtml(m.home.tla)}</div>
          ${live || finished ? `<div class="pl">${m.homeGoals ?? 0}–${m.awayGoals ?? 0}</div>` : '<div class="pl pending">×</div>'}
          <div>${crestImg(m.away)}${escapeHtml(m.away.tla)}</div>
        </div>
        ${p ? `${probBar(p)}<div class="problabels"><span>${pct(p.pHome)}</span><span>${pct(p.pDraw)}</span><span>${pct(p.pAway)}</span></div>` : ''}
      </a>`;
    })
    .join('');
  growBars($('#faixa'));
}

// ---------- Jogo em destaque no topo ----------

// Ao vivo primeiro; senão o próximo a começar; senão o último encerrado.
function pickHighlight(matches) {
  const live = matches.filter((m) => m.status === 'LIVE');
  if (live.length) return live[0];
  const next = matches.filter((m) => m.status === 'SCHEDULED').sort((a, b) => a.utcDate.localeCompare(b.utcDate));
  if (next.length) return next[0];
  return [...matches].sort((a, b) => b.utcDate.localeCompare(a.utcDate))[0];
}

async function loadHero() {
  const data = await api('/api/matches');
  const m = pickHighlight(data.matches);
  if (!m) {
    $('#destaque').innerHTML = '';
    return;
  }
  const live = m.status === 'LIVE';
  const finished = m.status === 'FINISHED';
  const date = new Date(m.utcDate);
  const when = date.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });
  const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const tag = live
    ? `<span class="tag-vivo"><i></i>AO VIVO${m.minute ? ` · ${m.minute}'` : ''}</span>`
    : finished
      ? '<span class="tag-vivo fim">ENCERRADO</span>'
      : `<span class="tag-vivo proximo">PRÓXIMO JOGO · ${escapeHtml(when)} · ${time}</span>`;
  const side = (t) => `<a class="lado" href="#/time/${t.id}">${crestImg(t)}<b>${escapeHtml(t.shortName)}</b></a>`;
  const p = m.prediction;
  const html = `${tag}
    <div class="placar">
      ${side(m.home)}
      <div class="gols">${live || finished ? `${m.homeGoals ?? 0}<span>×</span>${m.awayGoals ?? 0}` : '<span>vs</span>'}</div>
      ${side(m.away)}
    </div>
    ${
      p
        ? `<div class="chances">${probBar(p)}
      <div class="problabels"><span><b>${pct(p.pHome)}</b> ${escapeHtml(m.home.tla)}</span><span>Empate <b>${pct(p.pDraw)}</b></span><span>${escapeHtml(m.away.tla)} <b>${pct(p.pAway)}</b></span></div>
      <div class="palpite">${live ? 'Placar final mais provável' : 'Placar mais provável'}: ${p.likelyScore[0]} × ${p.likelyScore[1]}</div></div>`
        : ''
    }`;
  // Só redesenha se algo mudou, para as barras não recomeçarem a cada atualização.
  if (state.heroHtml === html) return;
  state.heroHtml = html;
  $('#destaque').innerHTML = html;
  growBars($('#destaque'));
}

// ---------- Jogos ----------

function matchCard(m, watchUrl) {
  const date = new Date(m.utcDate);
  const when = date.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
  const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const live = m.status === 'LIVE';
  const finished = m.status === 'FINISHED';

  const status = live
    ? `<span class="live-tag">● AO VIVO${m.minute ? ` ${m.minute}'` : ''}</span>`
    : finished
      ? 'Encerrado'
      : `${when} · ${time}`;

  const score =
    finished || live
      ? `<div class="score">${m.homeGoals ?? 0} × ${m.awayGoals ?? 0}</div>`
      : `<div class="score pending">${time}</div>`;

  let prediction = '';
  if (m.prediction) {
    const p = m.prediction;
    const [lh, la] = p.likelyScore;
    prediction = `
      <div>
        ${probBar(p)}
        <div class="problabels">
          <span><b>${pct(p.pHome)}</b> ${escapeHtml(m.home.tla)}</span>
          <span>Empate <b>${pct(p.pDraw)}</b></span>
          <span>${escapeHtml(m.away.tla)} <b>${pct(p.pAway)}</b></span>
        </div>
      </div>
      <div class="match-foot">
        <span>${live ? 'Placar final mais provável' : 'Placar mais provável'}: <b>${lh} × ${la}</b></span>
        <a class="watch" href="${escapeHtml(watchUrl)}" target="_blank" rel="noopener">📺 Assistir</a>
      </div>`;
  }

  return `<article class="match ${live ? 'live' : ''}">
    <div class="match-head"><span>${status}</span></div>
    <div class="scoreline">${teamHtml(m.home)}${score}${teamHtml(m.away)}</div>
    ${prediction}
  </article>`;
}

async function loadMatches() {
  const data = await api(`/api/matches?matchday=${state.matchday ?? ''}`);
  state.matchday = data.matchday;
  state.totalMatchdays = data.totalMatchdays;

  $('#round-title').textContent = `Rodada ${data.matchday}${data.matchday === data.currentMatchday ? ' (atual)' : ''}`;
  $('#prev-round').disabled = data.matchday <= 1;
  $('#next-round').disabled = data.matchday >= data.totalMatchdays;
  $('#matches').innerHTML = data.matches.map((m) => matchCard(m, data.watchUrl)).join('');
  growBars($('#matches'));
}

// ---------- Evolução ----------

async function loadEvolution() {
  const data = await api('/api/evolution');
  const n = data.teams.length;
  const datasets = data.teams.map((t, i) => ({
    label: t.team.shortName,
    data: t.positions,
    borderColor: `hsl(${(i * 360) / n}, 70%, 40%)`,
    backgroundColor: `hsl(${(i * 360) / n}, 70%, 40%)`,
    hidden: i >= 6,
    tension: 0.25,
    pointRadius: 2,
  }));

  if (state.evolutionChart) {
    state.evolutionChart.data.labels = data.matchdays;
    state.evolutionChart.data.datasets.forEach((ds, i) => (ds.data = datasets[i]?.data ?? []));
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
      plugins: { legend: { position: 'right' } },
    },
  });
}

// ---------- Acertos ----------

const OUTCOME_LABEL = { H: (m) => m.home.tla, D: () => 'Empate', A: (m) => m.away.tla };

function statCard(label, value, compare) {
  return `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div><div class="compare">${compare}</div></div>`;
}

function renderHistoryStats(s) {
  const better = (cond) => (cond ? '<span class="better">melhor</span>' : '<span class="worse">pior</span>');
  const brier = (v) => v.toFixed(3).replace('.', ',');
  $('#history-stats').innerHTML = [
    statCard(
      'Acerto do resultado',
      pct(s.accuracy),
      `${s.hits} de ${s.total} jogos · ${better(s.accuracy > s.baseline.homeAccuracy)} que apostar sempre no mandante (${pct(s.baseline.homeAccuracy)})`,
    ),
    statCard('Placar exato', pct(s.exactAccuracy), `${s.exactHits} placares cravados`),
    statCard(
      'Nota de precisão (Brier)',
      brier(s.brier),
      `quanto menor, melhor · ${better(s.brier < s.baseline.frequencyBrier)} que o palpite pela média histórica (${brier(s.baseline.frequencyBrier)})`,
    ),
  ].join('');
}

function renderComparison(models, background) {
  const best = (key, lowerIsBetter = false) =>
    models.reduce((a, b) => ((lowerIsBetter ? b[key] < a[key] : b[key] > a[key]) ? b : a)).kind;
  const bestAcc = best('accuracy');
  const bestExact = best('exactAccuracy');
  const bestBrier = best('brier', true);
  const cell = (m, key, text) => `<td class="${m.kind === key ? 'best' : ''}">${text}</td>`;

  $('#model-comparison').innerHTML = `<div class="table-wrap comparison">
    <table>
      <thead><tr><th class="left">Comparação de modelos</th><th>Acerto do resultado</th><th>Placar exato</th><th>Nota Brier (menor é melhor)</th></tr></thead>
      <tbody>${models
        .map(
          (m) => `<tr>
            <td class="left">${escapeHtml(m.label)}${m.active ? ' <span class="active-tag">em uso</span>' : ''}</td>
            ${cell(m, bestAcc, pct(m.accuracy))}
            ${cell(m, bestExact, pct(m.exactAccuracy))}
            ${cell(m, bestBrier, m.brier.toFixed(3).replace('.', ','))}
          </tr>`,
        )
        .join('')}</tbody>
    </table>
  </div>${backgroundNote(background)}`;
}

function backgroundNote(bg) {
  if (!bg?.early?.with || !bg.early.without) return '';
  const { with: w, without: wo } = bg.early;
  const brier = (v) => v.toFixed(3).replace('.', ',');
  const better = w.brier < wo.brier;
  const promoted = bg.newTeams.length
    ? ` Quem subiu (${bg.newTeams.map(escapeHtml).join(', ')}) começa com a força média dos rebaixados da temporada anterior, e não com a média da liga.`
    : '';
  return `<p class="muted bg-note">
    <b>Temporada anterior (${bg.seasons.map(escapeHtml).join(', ')}):</b> nas rodadas 1 a ${bg.earlyRounds}, quando ainda há poucos jogos,
    usar a temporada anterior ${better ? 'melhorou' : 'não melhorou'} as previsões:
    nota Brier ${brier(wo.brier)} → <b>${brier(w.brier)}</b>, acerto ${pct(wo.accuracy)} → <b>${pct(w.accuracy)}</b> (${w.matches} jogos).${promoted}
  </p>`;
}

function renderAccuracyChart(s) {
  const labels = s.byMatchday.map((r) => r.matchday);
  const values = s.byMatchday.map((r) => r.accuracy * 100);
  const average = labels.map(() => s.accuracy * 100);

  if (state.history.accuracyChart) {
    const chart = state.history.accuracyChart;
    chart.data.labels = labels;
    chart.data.datasets[0].data = values;
    chart.data.datasets[1].data = average;
    chart.update();
    return;
  }

  state.history.accuracyChart = new Chart($('#accuracy-chart'), {
    data: {
      labels,
      datasets: [
        {
          type: 'bar',
          label: 'Acerto na rodada',
          data: values,
          backgroundColor: '#0b7a3e',
          hoverBackgroundColor: '#3fa86a',
          borderRadius: { topLeft: 4, topRight: 4 },
          borderSkipped: 'bottom',
          categoryPercentage: 0.85,
          barPercentage: 0.9,
          order: 2,
        },
        {
          type: 'line',
          label: 'Média geral',
          data: average,
          borderColor: '#14231a',
          borderWidth: 2,
          borderDash: [6, 4],
          pointRadius: 0,
          pointHoverRadius: 0,
          order: 1,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { min: 0, max: 100, ticks: { callback: (v) => v + '%' }, grid: { color: '#ece6d6' } },
        x: { title: { display: true, text: 'Rodada' }, grid: { display: false } },
      },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { boxWidth: 12 } },
        tooltip: {
          callbacks: {
            title: (items) => `Rodada ${items[0].label}`,
            label: (item) => {
              if (item.datasetIndex === 1) return `Média geral: ${pct(state.history.summary.accuracy)}`;
              const r = state.history.summary.byMatchday[item.dataIndex];
              return `Acertou ${r.hits} de ${r.total} jogos (${pct(r.accuracy)})`;
            },
          },
        },
      },
    },
  });
}

function renderCalibrationChart(s) {
  const points = s.calibration.map((b) => ({ x: b.predicted * 100, y: b.observed * 100 }));

  if (state.history.calibrationChart) {
    state.history.calibrationChart.data.datasets[0].data = points;
    state.history.calibrationChart.update();
    return;
  }

  state.history.calibrationChart = new Chart($('#calibration-chart'), {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Modelo',
          data: points,
          borderColor: '#0b7a3e',
          backgroundColor: '#0b7a3e',
          borderWidth: 2,
          pointRadius: 5,
          pointHoverRadius: 7,
          pointBorderColor: '#fff',
          pointBorderWidth: 2,
        },
        {
          label: 'Calibração perfeita',
          data: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
          borderColor: '#6b6a5c',
          borderWidth: 1.5,
          borderDash: [6, 4],
          pointRadius: 0,
          pointHoverRadius: 0,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      scales: {
        x: { type: 'linear', min: 0, max: 100, ticks: { callback: (v) => v + '%' }, title: { display: true, text: 'Probabilidade prevista' }, grid: { color: '#ece6d6' } },
        y: { min: 0, max: 100, ticks: { callback: (v) => v + '%' }, title: { display: true, text: 'Aconteceu de fato' }, grid: { color: '#ece6d6' } },
      },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { boxWidth: 12 } },
        tooltip: {
          filter: (item) => item.datasetIndex === 0,
          callbacks: {
            title: () => '',
            label: (item) => {
              const b = state.history.summary.calibration[item.dataIndex];
              return [
                `Faixa ${Math.round(b.from * 100)}–${Math.round(b.to * 100)}%`,
                `Previsto: ${pct(b.predicted)} · Aconteceu: ${pct(b.observed)}`,
                `${b.total} previsões`,
              ];
            },
          },
        },
      },
    },
  });
}

const daysText = (d) => (d == null ? 'nunca (todos os jogos pesam igual)' : `${d} dias`);

function renderDecayCalibration(c) {
  const fmt = (v) => String(v).replace('.', ',');
  const defaultDays = daysText(c.halfLifeDays);
  let text;
  clearTimeout(state.history.decayRetry);

  switch (c.status) {
    case 'fixed':
      text = `Valor fixo no <code>.env</code>: <code>TIME_DECAY=${fmt(c.decay)}</code> (meia-vida de ${defaultDays}). Use <code>TIME_DECAY=auto</code> para calibrar pelo histórico.`;
      break;
    case 'too-few':
      text = `A calibração começa com ${c.minMatches} jogos encerrados (hoje: ${c.matches}). Antes disso a diferença entre os valores é só ruído. Até lá, a meia-vida é de ${defaultDays}.`;
      break;
    case 'running':
      text = `Calibrando… Enquanto isso, o modelo usa meia-vida de ${defaultDays}.`;
      state.history.decayRetry = setTimeout(() => state.tab === 'acertos' && refresh(), 3000);
      break;
    case 'error':
      text = `Não foi possível calibrar (${escapeHtml(c.error)}). O modelo usa meia-vida de ${defaultDays}.`;
      break;
    case 'done': {
      const lowest = c.points.reduce((a, b) => (b.brier < a.brier ? b : a));
      text =
        c.outcome === 'better'
          ? `<b>Em uso: meia-vida de ${defaultDays}</b> (<code>TIME_DECAY=${fmt(c.decay)}</code>). Esse valor foi claramente melhor que o padrão, jogo a jogo.`
          : `<b>Em uso: meia-vida de ${defaultDays}</b> (o padrão). O menor Brier saiu com ${daysText(lowest.halfLifeDays)}, mas nenhum valor foi <i>claramente</i> melhor que o padrão: com ${c.matches} jogos, a diferença pode ser só sorte.`;
      if (c.atEdge) text += ' O melhor valor ficou na ponta dos testados.';
      break;
    }
  }
  $('#decay-summary').innerHTML = text;

  const box = $('#decay-chart-box');
  box.hidden = !c.points;
  if (!c.points) return;

  const points = c.points;
  const chosen = points.findIndex((p) => p.decay === c.decay);
  upsertChart('decay', $('#decay-chart'), {
    type: 'line',
    data: {
      labels: points.map((p) => (p.halfLifeDays == null ? '∞' : `${p.halfLifeDays} d`)),
      datasets: [
        {
          label: 'Nota Brier',
          data: points.map((p) => p.brier),
          borderColor: '#6b6a5c',
          borderWidth: 2,
          tension: 0.2,
          pointRadius: points.map((_, i) => (i === chosen ? 8 : 4)),
          pointHoverRadius: points.map((_, i) => (i === chosen ? 10 : 6)),
          pointBackgroundColor: points.map((p, i) => (i === chosen ? '#0b7a3e' : p.significant ? '#3fa86a' : '#6b6a5c')),
          pointBorderColor: points.map((_, i) => (i === chosen ? '#14231a' : '#fff')),
          pointBorderWidth: 2,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      scales: {
        x: { title: { display: true, text: 'Meia-vida de um jogo  →  jogos antigos pesam cada vez menos' }, grid: { display: false } },
        y: { title: { display: true, text: 'Nota Brier (menor é melhor)' }, ticks: { callback: (v) => v.toFixed(3).replace('.', ',') }, grid: { color: '#ece6d6' } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (i) => {
              const p = points[i[0].dataIndex];
              return `Meia-vida: ${daysText(p.halfLifeDays)} (TIME_DECAY=${fmt(p.decay)})`;
            },
            label: (i) => {
              const p = points[i.dataIndex];
              const lines = [`Brier: ${p.brier.toFixed(4).replace('.', ',')} · acerto: ${pct(p.accuracy)}`];
              if (i.dataIndex === chosen) lines.push('● em uso');
              else if (p.decay === c.defaultDecay) lines.push('padrão');
              else lines.push(p.significant ? 'claramente melhor que o padrão' : 'diferença para o padrão pode ser sorte');
              return lines;
            },
          },
        },
      },
    },
  });
}

function historyRow(e) {
  const m = e.match;
  const p = e.prediction;
  return `<tr>
    <td class="left"><span class="matchup">${teamHtml(m.home, { short: true })} × ${teamHtml(m.away, { short: true })}</span></td>
    <td>
      <div class="mini-probbar">
        <div style="flex:${p.pHome}"></div><div style="flex:${p.pDraw}"></div><div style="flex:${p.pAway}"></div>
      </div>
      <span class="mini-probs">${pct(p.pHome)} / ${pct(p.pDraw)} / ${pct(p.pAway)}</span>
    </td>
    <td>${escapeHtml(OUTCOME_LABEL[e.predicted](m))}</td>
    <td>${p.likelyScore[0]} × ${p.likelyScore[1]}${e.exactHit ? ' 🎯' : ''}</td>
    <td class="points">${m.homeGoals} × ${m.awayGoals}</td>
    <td>${e.hit ? '<span class="result-icon hit">✓ acertou</span>' : '<span class="result-icon miss">✗ errou</span>'}</td>
  </tr>`;
}

async function loadHistory() {
  const h = state.history;
  const data = await api(`/api/history?matchday=${h.matchday ?? ''}`);
  const s = data.summary;

  if (!s.total) {
    $('#history-stats').innerHTML = '<div class="empty">Ainda não há jogos encerrados para avaliar.</div>';
    return;
  }

  h.matchday = data.matchday;
  h.first = data.firstMatchday;
  h.last = data.lastMatchday;

  h.summary = s;
  renderHistoryStats(s);
  renderComparison(data.comparison, data.background);
  renderDecayCalibration(data.calibration);
  renderAccuracyChart(s);
  renderCalibrationChart(s);

  const round = s.byMatchday.find((r) => r.matchday === data.matchday);
  $('#history-title').textContent = `Rodada ${data.matchday}${round ? ` · ${round.hits} de ${round.total} acertos` : ''}`;
  $('#history-prev').disabled = data.matchday <= h.first;
  $('#history-next').disabled = data.matchday >= h.last;
  $('#history-body').innerHTML = data.entries.map(historyRow).join('');
}

// ---------- Página do time ----------

const ZONE_COLORS = { lib: '#0b7a3e', sul: '#1d4fd8', reb: '#d7263d', mid: '#cfc8b5' };
const RESULT_WORDS = {
  V: ['vitória', 'vitórias seguidas'],
  E: ['empate', 'empates seguidos'],
  D: ['derrota', 'derrotas seguidas'],
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Cria o gráfico ou, se ele já existe, só troca os dados (sem piscar a cada atualização). */
function upsertChart(key, canvas, config) {
  state.charts ??= {};
  const chart = state.charts[key];
  if (chart) {
    chart.data = config.data;
    chart.options = config.options;
    chart.update('none');
    return;
  }
  state.charts[key] = new Chart(canvas, config);
}

function ratingText(value, kind) {
  const diff = Math.round(Math.abs(value - 1) * 100);
  if (kind === 'attack') return diff === 0 ? 'na média da liga' : `marca ${diff}% ${value > 1 ? 'mais' : 'menos'} que a média`;
  return diff === 0 ? 'na média da liga' : `sofre ${diff}% ${value < 1 ? 'menos' : 'mais'} que a média`;
}

function renderTeamHeader(d) {
  const t = d.team;
  const icon = t.crest
    ? `<img class="crest big" src="${escapeHtml(t.crest)}" alt="" />`
    : `<span class="badge big">${escapeHtml(t.tla)}</span>`;
  $('#team-header').innerHTML = `${icon}<div><h2>${escapeHtml(t.name)}</h2>
    <p class="muted">${d.standing.position}º lugar · ${d.standing.points} pontos em ${d.standing.played} jogos</p></div>`;
}

function renderTeamStats(d) {
  const o = d.outlook;
  const r = d.ratings;
  $('#team-stats').innerHTML = [
    statCard('Pontos projetados', o.expectedPoints.toFixed(1).replace('.', ','), `hoje tem ${d.standing.points} · previsão para o fim do campeonato`),
    statCard(
      'Chances',
      `<span class="chance-line"><small>Título</small> ${pct(o.title)}</span>`,
      `Libertadores ${pct(o.libertadores)} · Rebaixamento ${pct(o.relegation)}`,
    ),
    statCard('Ataque', `${r.attackRank}º`, `da liga · ${ratingText(r.attack, 'attack')}`),
    statCard('Defesa', `${r.defenseRank}º`, `da liga · ${ratingText(r.defense, 'defense')}`),
  ].join('');
}

function renderTeamCharts(d) {
  const total = d.totalTeams;
  const zoneOf = (pos) =>
    pos <= d.zones.libertadores ? 'lib' : pos <= d.zones.sulamericana ? 'sul' : pos > total - d.zones.relegation ? 'reb' : 'mid';

  upsertChart('teamPosition', $('#team-position-chart'), {
    type: 'line',
    data: {
      labels: d.evolution.matchdays,
      datasets: [
        {
          label: 'Posição',
          data: d.evolution.positions,
          borderColor: '#0b7a3e',
          backgroundColor: '#0b7a3e',
          borderWidth: 2,
          tension: 0.25,
          pointRadius: 3,
          pointHoverRadius: 6,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { reverse: true, min: 1, max: total, ticks: { stepSize: 1, callback: (v) => (v === 1 || v % 5 === 0 ? `${v}º` : '') }, grid: { color: '#ece6d6' } },
        x: { title: { display: true, text: 'Rodada' }, grid: { display: false } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: (i) => `Rodada ${i[0].label}`, label: (i) => `${i.raw}º lugar` } },
      },
    },
  });

  const positions = d.outlook.positionProbs.map((_, i) => i + 1);
  upsertChart('teamFinal', $('#team-final-chart'), {
    type: 'bar',
    data: {
      labels: positions.map((p) => `${p}º`),
      datasets: [
        {
          label: 'Chance',
          data: d.outlook.positionProbs.map((p) => p * 100),
          backgroundColor: positions.map((p) => ZONE_COLORS[zoneOf(p)]),
          borderRadius: { topLeft: 4, topRight: 4 },
          borderSkipped: 'bottom',
          categoryPercentage: 0.9,
          barPercentage: 0.9,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      scales: {
        y: { beginAtZero: true, ticks: { callback: (v) => v + '%' }, grid: { color: '#ece6d6' } },
        x: { grid: { display: false } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: (i) => `Terminar em ${i[0].label}`, label: (i) => pct(i.raw / 100) } },
      },
    },
  });

  // Gols por jogo: marcados para cima, sofridos para baixo
  const games = [...d.results].reverse();
  upsertChart('teamGoals', $('#team-goals-chart'), {
    type: 'bar',
    data: {
      labels: games.map((g) => g.match.matchday),
      datasets: [
        {
          label: 'Gols marcados',
          data: games.map((g) => g.goalsFor),
          backgroundColor: '#0b7a3e',
          borderRadius: 4,
          borderSkipped: false,
        },
        {
          label: 'Gols sofridos',
          data: games.map((g) => -g.goalsAgainst),
          backgroundColor: '#d7263d',
          borderRadius: 4,
          borderSkipped: false,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: true, title: { display: true, text: 'Rodada' }, grid: { display: false } },
        y: { stacked: true, ticks: { stepSize: 1, callback: (v) => Math.abs(v) }, grid: { color: (c) => (c.tick.value === 0 ? '#6b6a5c' : '#ece6d6') } },
      },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { boxWidth: 12 } },
        tooltip: {
          callbacks: {
            title: (i) => {
              const g = games[i[0].dataIndex];
              return `Rodada ${g.match.matchday} · ${g.home ? 'em casa' : 'fora'} contra ${g.opponent.shortName}`;
            },
            label: (i) => `${i.dataset.label}: ${Math.abs(i.raw)}`,
          },
        },
      },
    },
  });
}

function renderTeamSplit(d) {
  const all = {
    played: d.home.played + d.away.played,
    won: d.home.won + d.away.won,
    drawn: d.home.drawn + d.away.drawn,
    lost: d.home.lost + d.away.lost,
    goalsFor: d.home.goalsFor + d.away.goalsFor,
    goalsAgainst: d.home.goalsAgainst + d.away.goalsAgainst,
    points: d.home.points + d.away.points,
  };
  all.efficiency = all.played ? all.points / (3 * all.played) : 0;

  const row = (label, s) => `<tr>
    <td class="left">${label}</td><td class="points">${s.points}</td><td>${s.played}</td><td>${s.won}</td><td>${s.drawn}</td><td>${s.lost}</td>
    <td>${s.goalsFor}</td><td>${s.goalsAgainst}</td><td><b>${pct(s.efficiency)}</b></td>
  </tr>`;
  $('#team-split').innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th></th><th>P</th><th>J</th><th>V</th><th>E</th><th>D</th><th title="Gols pró">GP</th><th title="Gols contra">GC</th><th title="Pontos ganhos / pontos disputados">Aprov.</th></tr></thead>
    <tbody>${row('Em casa', d.home)}${row('Fora', d.away)}${row('Total', all)}</tbody>
  </table></div>`;
}

function renderTeamStreaks(d) {
  const s = d.streaks;
  const game = (r) =>
    r
      ? `${r.goalsFor} × ${r.goalsAgainst} ${r.result === 'V' ? 'sobre o' : 'para o'} ${escapeHtml(r.opponent.shortName)} <span class="muted">(rodada ${r.match.matchday}, ${r.home ? 'em casa' : 'fora'})</span>`
      : '–';
  const items = [];
  if (s.current) {
    const [one, many] = RESULT_WORDS[s.current.result];
    items.push(['Momento', `<span class="form"><span class="${s.current.result}">${s.current.result}</span></span> ${plural(s.current.length, one, many)}`]);
  }
  items.push(
    s.unbeaten > 0
      ? ['Invencibilidade', `${plural(s.unbeaten, 'jogo', 'jogos')} sem perder`]
      : ['Sem vencer', plural(s.winless, 'jogo', 'jogos')],
    ['Maior sequência de vitórias', plural(s.longestWinning, 'jogo', 'jogos')],
    ['Maior invencibilidade', plural(s.longestUnbeaten, 'jogo', 'jogos')],
    ['Maior vitória', game(s.biggestWin)],
    ['Maior derrota', game(s.biggestLoss)],
  );
  $('#team-streaks').innerHTML = `<dl class="facts">${items.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

function renderTeamResults(d) {
  if (!d.results.length) {
    $('#team-results').innerHTML = '<div class="empty">Nenhum jogo encerrado ainda.</div>';
    return;
  }
  $('#team-results').innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Rodada</th><th>Data</th><th class="left">Adversário</th><th>Placar</th><th></th></tr></thead>
    <tbody>${d.results
      .map((r) => {
        const m = r.match;
        const date = new Date(m.utcDate).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        return `<tr>
          <td>${m.matchday}</td>
          <td>${date}</td>
          <td class="left"><span class="matchup">${teamHtml(r.opponent)} <span class="venue">${r.home ? 'casa' : 'fora'}</span></span></td>
          <td class="points">${escapeHtml(m.home.tla)} ${m.homeGoals} × ${m.awayGoals} ${escapeHtml(m.away.tla)}</td>
          <td><span class="form"><span class="${r.result}">${r.result}</span></span></td>
        </tr>`;
      })
      .join('')}</tbody>
  </table></div>`;
}

async function loadTeam() {
  const d = await api(`/api/teams/${state.teamId}`);
  document.title = `${d.team.shortName} · Painel do Brasileirão`;

  renderTeamHeader(d);
  renderTeamStats(d);
  renderTeamCharts(d);
  renderTeamSplit(d);
  renderTeamStreaks(d);
  $('#team-upcoming').innerHTML = d.upcoming.length
    ? d.upcoming.map((m) => matchCard(m, d.watchUrl)).join('')
    : '<div class="empty">Não há mais jogos no campeonato.</div>';
  renderTeamResults(d);
}

// ---------- Scout de jogadores ----------

state.scout = { sort: null, dir: 'desc', teamsLoaded: false, retry: null };

const PLAYER_COLOR = '#0b7a3e';
const COMPARE_COLOR = '#1d4fd8';

function formatMetric(m, value = m.value) {
  if (value == null) return '–';
  if (m.format === 'pct') return `${Math.round(value)}%`;
  return value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function playerAvatar(p, big = false) {
  const initials = p.name
    .split(/\s+/)
    .filter((w) => /^[A-Za-zÀ-ú]/.test(w))
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return p.photo
    ? `<img class="avatar${big ? ' big' : ''}" src="${escapeHtml(p.photo)}" alt="" loading="lazy" />`
    : `<span class="avatar${big ? ' big' : ''}">${escapeHtml(initials)}</span>`;
}

/** Mostra o andamento quando os jogadores ainda estão carregando; devolve true se está pronto. */
function renderScoutStatus(status, targetSel) {
  const el = $(targetSel);
  clearTimeout(state.scout.retry);

  if (status.error) {
    el.innerHTML = `<div class="banner error">Não foi possível carregar os jogadores: ${escapeHtml(status.error)}</div>`;
    return false;
  }
  if (!status.ready) {
    const total = status.total ? ` de ~${status.total}` : '';
    el.innerHTML = `<div class="empty">Carregando jogadores da ${escapeHtml(status.source)}: ${status.loaded}${total}…<br />
      <span class="muted">A primeira carga demora alguns minutos por causa do limite do plano grátis. Depois fica guardada por 24 horas.</span></div>`;
    state.scout.retry = setTimeout(refresh, 5000);
    return false;
  }
  el.innerHTML =
    status.source === 'jogadores de exemplo'
      ? '<div class="banner">Jogadores de exemplo (números sorteados). Coloque sua chave da API-Football em <code>APIFOOTBALL_KEY</code> no arquivo <code>.env</code> para usar os dados reais.</div>'
      : '';
  return true;
}

function percentileChip(p) {
  if (p == null) return '';
  const tier = p >= 80 ? 'top' : p >= 50 ? 'mid' : 'low';
  return `<span class="pchip ${tier}" title="Percentil ${Math.round(p)}">${Math.round(p)}</span>`;
}

async function loadScout() {
  const s = state.scout;
  const params = new URLSearchParams({
    q: $('#scout-q').value,
    position: $('#scout-position').value,
    team: $('#scout-team').value,
    minMinutes: $('#scout-minutes').value,
    dir: s.dir,
  });
  if (s.sort) params.set('sort', s.sort);
  const data = await api(`/api/players?${params}`);
  const hasRows = renderScoutStatus(data.status, '#scout-status');
  document.querySelector('#scout .filters').hidden = !hasRows;
  document.querySelector('#scout .table-wrap').hidden = !hasRows;
  $('#scout-count').hidden = !hasRows;
  if (!hasRows) return;

  if (!s.teamsLoaded) {
    $('#scout-team').insertAdjacentHTML('beforeend', data.teams.map((t) => `<option>${escapeHtml(t)}</option>`).join(''));
    s.teamsLoaded = true;
  }

  const activeSort = s.sort && (['name', 'minutes', 'age'].includes(s.sort) || data.columns.some((c) => c.key === s.sort)) ? s.sort : data.columns[0].key;
  const th = (key, label, cls = '') =>
    `<th class="sortable ${cls} ${key === activeSort ? 'sorted' : ''}" data-sort="${key}">${label}${key === activeSort ? (s.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`;
  $('#scout-head').innerHTML = `<tr>
    ${th('name', 'Jogador', 'left')}<th class="left">Time</th><th class="hide-sm">Posição</th>${th('age', 'Idade', 'hide-sm')}${th('minutes', 'Min')}
    ${data.columns.map((c) => th(c.key, escapeHtml(c.label) + (c.format === 'per90' ? '<small>/90</small>' : ''))).join('')}
  </tr>`;

  $('#scout-count').textContent =
    data.total > data.players.length ? `Mostrando ${data.players.length} de ${data.total} jogadores` : `${data.total} jogadores`;

  $('#scout-body').innerHTML = data.players.length
    ? data.players
        .map(
          (p) => `<tr>
        <td class="left"><a class="player-link" href="#/jogador/${p.id}">${playerAvatar(p)}<span>${escapeHtml(p.name)}</span></a></td>
        <td class="left">${escapeHtml(p.team.name)}</td>
        <td class="hide-sm">${escapeHtml(p.position)}</td>
        <td class="hide-sm">${p.age ?? '–'}</td>
        <td>${p.minutes}</td>
        ${p.metrics.map((m) => `<td class="metric">${formatMetric(m)} ${percentileChip(m.percentile)}</td>`).join('')}
      </tr>`,
        )
        .join('')
    : `<tr><td colspan="${5 + data.columns.length}" class="muted">Nenhum jogador com esses filtros.</td></tr>`;
}

function renderRadar(d) {
  const labels = d.metrics.map((m) => m.short);
  const dataset = (label, metrics, color) => ({
    label,
    data: metrics.map((m) => m.percentile ?? 0),
    borderColor: color,
    backgroundColor: color + '33',
    borderWidth: 2,
    pointBackgroundColor: color,
    pointBorderColor: '#fff',
    pointBorderWidth: 2,
    pointRadius: 4,
    pointHoverRadius: 6,
  });
  const sets = [dataset(d.player.name, d.metrics, PLAYER_COLOR)];
  if (d.compare) sets.push(dataset(d.compare.player.name, d.compare.metrics, COMPARE_COLOR));
  const all = [d.metrics, d.compare?.metrics];

  upsertChart('radar', $('#radar-chart'), {
    type: 'radar',
    data: { labels, datasets: sets },
    options: {
      maintainAspectRatio: false,
      scales: {
        r: {
          min: 0,
          max: 100,
          ticks: { stepSize: 25, display: false },
          grid: { color: '#e2dccb' },
          angleLines: { color: '#e2dccb' },
          pointLabels: { color: '#14231a', font: { size: 12 } },
        },
      },
      plugins: {
        legend: { display: !!d.compare, position: 'top', labels: { boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: (item) => {
              const m = all[item.datasetIndex][item.dataIndex];
              const unit = m.format === 'per90' ? ' por 90 min' : '';
              return `${item.dataset.label}: ${formatMetric(m)}${unit} · percentil ${m.percentile == null ? '–' : Math.round(m.percentile)}`;
            },
          },
        },
      },
    },
  });
}

function renderPlayerMetrics(d) {
  const bar = (p, color) =>
    `<div class="prow"><div class="pbar"><div style="width:${p ?? 0}%; background:${color}"></div></div><span class="pnum">${p == null ? '–' : Math.round(p)}</span></div>`;
  $('#player-metrics').innerHTML = `<table class="metrics-table">
    <thead><tr><th class="left">Métrica</th><th>Valor</th><th class="left">Percentil</th></tr></thead>
    <tbody>${d.metrics
      .map((m, i) => {
        const c = d.compare?.metrics[i];
        return `<tr>
          <td class="left">${escapeHtml(m.label)}${m.lowerIsBetter ? ' <span class="muted">(menos é melhor)</span>' : ''}</td>
          <td>${formatMetric(m)}${c ? `<br /><span class="vs-value">${formatMetric(c)}</span>` : ''}</td>
          <td class="left pcell">${bar(m.percentile, PLAYER_COLOR)}${c ? bar(c.percentile, COMPARE_COLOR) : ''}</td>
        </tr>`;
      })
      .join('')}</tbody>
  </table>`;
}

async function loadPlayer() {
  const vs = state.compareId ? `?vs=${state.compareId}` : '';
  const d = await api(`/api/players/${state.playerId}${vs}`);
  if (!renderScoutStatus(d.status, '#player-note')) return;

  const p = d.player;
  document.title = `${p.name} · Scout`;
  const team = p.matchTeamId
    ? `<a href="#/time/${p.matchTeamId}" class="inline-link">${escapeHtml(p.team.name)}</a>`
    : escapeHtml(p.team.name);
  $('#player-header').innerHTML = `${playerAvatar(p, true)}<div>
    <h2>${escapeHtml(p.name)}</h2>
    <p class="muted">${escapeHtml(p.position)} · ${team}${p.age ? ` · ${p.age} anos` : ''}${p.nationality ? ` · ${escapeHtml(p.nationality)}` : ''}</p>
    <p class="muted">${p.appearances} jogos · ${p.minutes} minutos · ${p.goals} gols · ${p.assists} assistências</p>
  </div>`;

  $('#radar-caption').textContent = `Percentil em cada métrica, comparado a ${d.poolSize} ${d.player.position === 'Meio-campista' ? 'meio-campistas' : d.player.position.toLowerCase() + 's'} com ${d.status.minMinutes}+ minutos. Mais longe do centro = melhor.`;
  if (d.belowMinimum) {
    $('#player-note').insertAdjacentHTML(
      'beforeend',
      `<div class="banner">Jogou só ${p.minutes} minutos: os números por 90 minutos ainda oscilam muito.</div>`,
    );
  }

  // Seletor de comparação
  $('#compare-options').innerHTML = d.samePosition
    .map((o) => `<option value="${escapeHtml(`${o.name} — ${o.team}`)}"></option>`)
    .join('');
  state.compareChoices = new Map(d.samePosition.map((o) => [`${o.name} — ${o.team}`, o.id]));
  $('#compare-input').value = d.compare ? `${d.compare.player.name} — ${d.compare.player.team.name}` : '';
  $('#compare-clear').hidden = !d.compare;

  renderRadar(d);
  renderPlayerMetrics(d);

  $('#player-similar').innerHTML = d.similar.length
    ? d.similar
        .map(
          (s) => `<div class="similar-card">
        <a class="player-link" href="#/jogador/${s.id}">${playerAvatar(s)}<span><b>${escapeHtml(s.name)}</b><br /><span class="muted">${escapeHtml(s.team.name)} · ${s.minutes} min</span></span></a>
        <div class="similar-foot">
          <span class="similarity">${Math.round(s.similarity * 100)}% parecido</span>
          <a class="small-btn" href="#/jogador/${p.id}/vs/${s.id}">Comparar</a>
        </div>
      </div>`,
        )
        .join('')
    : '<div class="empty">Ainda não há jogadores suficientes nessa posição para comparar.</div>';
}

let scoutSearchTimer;
$('#scout-q').addEventListener('input', () => {
  clearTimeout(scoutSearchTimer);
  scoutSearchTimer = setTimeout(refresh, 250);
});
$('#scout-position').addEventListener('change', () => {
  // Cada posição tem colunas diferentes: volta para a ordenação padrão
  state.scout.sort = null;
  state.scout.dir = 'desc';
  refresh();
});
['#scout-team', '#scout-minutes'].forEach((sel) => $(sel).addEventListener('change', refresh));
$('#scout-head').addEventListener('click', (e) => {
  const key = e.target.closest('[data-sort]')?.dataset.sort;
  if (!key) return;
  const s = state.scout;
  if (s.sort === key) s.dir = s.dir === 'desc' ? 'asc' : 'desc';
  else {
    s.sort = key;
    s.dir = key === 'name' ? 'asc' : 'desc';
  }
  refresh();
});
$('#compare-input').addEventListener('change', (e) => {
  const id = state.compareChoices?.get(e.target.value);
  if (id) location.hash = `#/jogador/${state.playerId}/vs/${id}`;
});
$('#compare-clear').addEventListener('click', () => {
  location.hash = `#/jogador/${state.playerId}`;
});

// ---------- Artilharia ----------

async function loadScorers() {
  const data = await api('/api/scorers');
  if (!data.scorers) {
    $('#scorers').innerHTML = `<div class="empty">
      A artilharia aparece quando você usa dados reais.<br />
      Coloque seu token em <code>FOOTBALL_DATA_TOKEN</code> no arquivo <code>.env</code> e reinicie o servidor.
    </div>`;
    return;
  }
  $('#scorers').innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>#</th><th class="left">Jogador</th><th class="left">Time</th><th>Gols</th><th>Assist.</th><th>Pênaltis</th></tr></thead>
    <tbody>${data.scorers
      .map(
        (s, i) => `<tr>
          <td>${i + 1}</td>
          <td class="left">${escapeHtml(s.player)}</td>
          <td class="left">${teamHtml(s.team)}</td>
          <td class="points">${s.goals}</td>
          <td>${s.assists ?? '–'}</td>
          <td>${s.penalties ?? '–'}</td>
        </tr>`,
      )
      .join('')}</tbody>
  </table></div>`;
}

// ---------- Navegação ----------

const loaders = {
  tabela: loadOverview,
  jogos: loadMatches,
  evolucao: loadEvolution,
  acertos: loadHistory,
  artilharia: loadScorers,
  time: loadTeam,
  scout: loadScout,
  jogador: loadPlayer,
};

async function refresh() {
  try {
    const hero = loadHero();
    if (!state.metaSet && state.tab !== 'tabela') api('/api/overview').then(setMeta, () => {});
    await loaders[state.tab]();
    await hero;
  } catch (err) {
    showBanner(`Não foi possível carregar os dados: ${err.message}`, true);
  }
}

// Navegação pelo endereço: #/jogos, #/time/12 etc. (o botão "voltar" do navegador funciona)
function applyRoute() {
  const [page, id, , vsId] = location.hash.replace(/^#\/?/, '').split('/');
  if (page === 'time' && Number(id)) {
    state.tab = 'time';
    state.teamId = Number(id);
    window.scrollTo(0, 0);
  } else if (page === 'jogador' && Number(id)) {
    // #/jogador/12 ou #/jogador/12/vs/34
    state.tab = 'jogador';
    if (state.playerId !== Number(id)) window.scrollTo(0, 0);
    state.playerId = Number(id);
    state.compareId = Number(vsId) || null;
  } else {
    state.tab = loaders[page] && page !== 'time' && page !== 'jogador' ? page : 'tabela';
    document.title = 'Painel do Brasileirão';
  }
  const activeTab = state.tab === 'jogador' ? 'scout' : state.tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === state.tab));
  refresh();
}

document.querySelectorAll('.tab').forEach((btn) =>
  btn.addEventListener('click', () => {
    location.hash = `#/${btn.dataset.tab}`;
  }),
);
window.addEventListener('hashchange', applyRoute);

$('#prev-round').addEventListener('click', () => {
  state.matchday = Math.max(1, state.matchday - 1);
  refresh();
});
$('#next-round').addEventListener('click', () => {
  state.matchday = Math.min(state.totalMatchdays, state.matchday + 1);
  refresh();
});

$('#history-prev').addEventListener('click', () => {
  state.history.matchday = Math.max(state.history.first, state.history.matchday - 1);
  refresh();
});
$('#history-next').addEventListener('click', () => {
  state.history.matchday = Math.min(state.history.last, state.history.matchday + 1);
  refresh();
});

applyRoute();
setInterval(refresh, REFRESH_MS);
