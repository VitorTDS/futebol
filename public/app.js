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

// Campeonato aberto: Brasileirão (bsa) ou uma copa: Libertadores (lib), Copa do Brasil (cdb)
state.comp = 'bsa';
const CUP_INFO = {
  lib: { name: 'Libertadores', title: 'CONMEBOL Libertadores 2026', slogan: 'a glória eterna', groups: true },
  cdb: { name: 'Copa do Brasil', title: 'Copa do Brasil 2026', slogan: 'vaga direta na Libertadores', groups: false },
};
const isCup = () => state.comp in CUP_INFO;
const cupApi = (p) => `/api/${state.comp}${p}`;
// Na Libertadores, todo clube (brasileiro ou não) tem a sua página
const teamHref = (id) => (isCup() ? `#/${state.comp}/time/${id}` : `#/time/${id}`);
const jogoHref = (id) => (isCup() ? `#/${state.comp}/jogo/${id}` : `#/jogo/${id}`);

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
  const name = `${icon}<span>${escapeHtml(short ? team.tla : team.shortName)}</span>`;
  if (team.tbd) return `<span class="team">${name}</span>`;
  return `<a class="team" href="${teamHref(team.id)}">${name}</a>`;
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

const RESULT_LABEL = { V: 'Vitória', E: 'Empate', D: 'Derrota' };

// Letra da forma recente (V/E/D) que abre a partida em que aconteceu
function formLink(result, game) {
  if (!game) return `<span class="${result}">${result}</span>`;
  return `<a class="${result}" href="${jogoHref(game.id)}" title="${RESULT_LABEL[result]}: ${escapeHtml(game.score)}" aria-label="${RESULT_LABEL[result]}: ${escapeHtml(game.score)}">${result}</a>`;
}

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
        <td class="hide-sm">${row.won}</td>
        <td class="hide-sm">${row.drawn}</td>
        <td class="hide-sm">${row.lost}</td>
        <td>${row.goalDiff > 0 ? '+' : ''}${row.goalDiff}</td>
        <td><span class="form">${row.form.map((r, i) => formLink(r, row.formMatches[i])).join('')}</span></td>
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
  renderZoneNote(data.zoneOutlook);
  growBars($('#tabela'));
  await loadStrip();
}

// Diz quais copas entram nas vagas com a simulação da própria aba
function cupSourcesText(s) {
  const parts = [];
  if (s?.copaDoBrasil) parts.push('quem chega à final da <a href="#/cdb/chave">Copa do Brasil</a>');
  if (s?.libertadores) parts.push('quem ganha a <a href="#/lib/chave">Libertadores</a>');
  return parts.length ? `As chances de ${parts.join(' e de ')} são as mesmas das abas de cada copa.` : '';
}

// Explica até onde vão as vagas, que dependem das copas ainda em disputa.
function renderZoneNote(z) {
  const el = $('#zone-note');
  el.hidden = !z?.withCups;
  if (el.hidden) return;
  const dist = (probs) =>
    probs
      .map((p, i) => ({ pos: i + 1, p }))
      .filter((x) => x.p >= 0.01)
      .map((x) => `<span class="chip">até o ${x.pos}º <b>${pct(x.p)}</b></span>`)
      .join('');
  el.innerHTML = `<b>Vagas mudam com as copas.</b> O Brasileirão dá 5 vagas na Libertadores, mas o campeão e o vice da Copa do Brasil
    e os campeões brasileiros da Libertadores e da Sul-Americana também se classificam. Quando quem ganha já está no G5, a vaga desce na tabela.
    ${cupSourcesText(z.cupSources)}
    <span class="dist"><span class="muted">Libertadores pela tabela:</span> ${dist(z.libertadoresCutoff)}</span>
    <span class="dist"><span class="muted">Sul-Americana:</span> ${dist(z.sulamericanaCutoff)}</span>`;
}

const RACES = { title: 'var(--titulo)', libertadores: 'var(--lib)', relegation: 'var(--reb)' };

function renderRace(standings) {
  for (const [key, color] of Object.entries(RACES)) {
    const top = standings
      .filter((r) => r.outlook[key] > 0)
      .sort((a, b) => b.outlook[key] - a.outlook[key])
      .slice(0, key === 'libertadores' ? 10 : 6);
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
      return `<a class="jogo ${live ? 'live' : ''}" href="${jogoHref(m.id)}" style="animation-delay:${i * 50}ms">
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
  const data = await api(isCup() ? cupApi('/matches') : '/api/matches');
  checkAlerts(data.matches);
  // Alertas de gol valem para todos os campeonatos
  if (alerts.on) {
    for (const url of ['/api/matches', '/api/lib/matches', '/api/cdb/matches']) {
      if (url !== (isCup() ? cupApi('/matches') : '/api/matches')) api(url).then((other) => checkAlerts(other.matches), () => {});
    }
  }
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
  const side = (t) =>
    isCup()
      ? `<a class="lado" href="${teamHref(t.id)}">${crestImg(t)}<b>${escapeHtml(t.shortName)}</b></a>`
      : `<a class="lado" href="#/time/${t.id}">${crestImg(t)}<b>${escapeHtml(t.shortName)}</b></a>`;
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
    }
    <a class="ver-detalhes" href="${jogoHref(m.id)}">Ver detalhes do jogo ›</a>`;
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

  return `<article class="match ${live ? 'live' : ''}" data-jogo="${m.id}">
    <div class="match-head"><span>${status}</span></div>
    <div class="scoreline">${teamHtml(m.home)}${score}${teamHtml(m.away)}</div>
    ${prediction}
    <a class="ver-jogo" href="${jogoHref(m.id)}">Ver detalhes do jogo ›</a>
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
        return `<tr class="linha-jogo" data-jogo="${m.id}">
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
  $('#scorers').innerHTML = scorersTable(data.scorers);
}

function scorersTable(scorers) {
  if (!scorers?.length) return '<div class="empty">Ainda não há artilharia.</div>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>#</th><th class="left">Jogador</th><th class="left">Time</th><th>Gols</th><th>Assist.</th><th>Pênaltis</th></tr></thead>
    <tbody>${scorers
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

// ---------- Página do jogo ----------

state.jogo = { id: null, tab: 'resumo', data: null };

const JOGO_TABS = [
  ['resumo', 'Resumo'],
  ['estatisticas', 'Estatísticas'],
  ['escalacoes', 'Escalações'],
  ['confronto', 'Confronto'],
  ['tabela', 'Tabela'],
];

const EVENT_ICON = {
  goal: '<span class="ev-ico">⚽</span>',
  penalty: '<span class="ev-ico">⚽</span>',
  'own-goal': '<span class="ev-ico contra">⚽</span>',
  'missed-penalty': '<span class="ev-ico">✕</span>',
  yellow: '<span class="cartao amarelo"></span>',
  red: '<span class="cartao vermelho"></span>',
  sub: '<span class="ev-ico troca">⇅</span>',
};

// Cores dos dois times vindas da ESPN, com texto preto ou branco conforme o fundo.
// Se forem parecidas (Flamengo x Fluminense), o visitante usa a cor alternativa.
function matchColors(espn) {
  const valid = (hex) => (/^[0-9a-f]{6}$/i.test(hex ?? '') ? `#${hex}` : null);
  const rgb = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  const far = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i])) > 120;
  const home = valid(espn?.colors.home.main) ?? '#0b7a3e';
  const away = [espn?.colors.away.main, espn?.colors.away.alt].map(valid).find((c) => c && far(c, home)) ?? (far('#1d4fd8', home) ? '#1d4fd8' : '#ffcc00');
  const fg = (c) => {
    const [r, g, b] = rgb(c);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#14231a' : '#fff';
  };
  return { home: { bg: home, fg: fg(home) }, away: { bg: away, fg: fg(away) } };
}

async function loadMatchPage() {
  const j = state.jogo;
  if (j.data?.match.id !== j.id) j.data = null;
  if (!j.data) $('#jogo-body').innerHTML = '<p class="muted">Carregando o jogo…</p>';
  j.data = await api(isCup() ? cupApi(`/jogo/${j.id}`) : `/api/jogo/${j.id}`);
  const { match: m } = j.data;
  document.title = `${m.home.shortName} x ${m.away.shortName} · ${isCup() ? CUP_INFO[state.comp].name : 'Brasileirão'}`;
  renderMatchPage();
}

function renderMatchPage() {
  const d = state.jogo.data;
  const { match: m, espn } = d;
  const live = m.status === 'LIVE';
  const finished = m.status === 'FINISHED';
  const date = new Date(m.utcDate);
  const when = date.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
  const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const status = live
    ? `<span class="live-tag">● AO VIVO${m.minute ? ` · ${m.minute}'` : ''}</span>`
    : finished
      ? 'Encerrado'
      : `${when} · ${time}`;
  const scorers = (side) =>
    (espn?.events ?? [])
      .filter((e) => ['goal', 'penalty', 'own-goal'].includes(e.type) && e.side === side)
      .map((e) => `<li>${escapeHtml(e.player)} ${e.minute}${e.type === 'penalty' ? ' (pên.)' : e.type === 'own-goal' ? ' (contra)' : ''}</li>`)
      .join('');
  const side = (t, s) => `<a class="jh-time" href="#/time/${t.id}">${crestImg(t)}<b>${escapeHtml(t.shortName)}</b>
    <small>${d[s].standing ? `${d[s].standing.position}º · ${d[s].standing.points} pts` : ''}</small></a>`;

  $('#jogo-header').innerHTML = `
    <div class="jh-status">${status}</div>
    <div class="jh-placar">
      ${side(m.home, 'home')}
      <div class="jh-gols">${live || finished ? `${m.homeGoals ?? 0}<span>–</span>${m.awayGoals ?? 0}` : `<span class="jh-hora">${time}</span>`}</div>
      ${side(m.away, 'away')}
    </div>
    ${espn?.events?.some((e) => ['goal', 'penalty', 'own-goal'].includes(e.type)) ? `<div class="jh-autores"><ul>${scorers('home')}</ul><span>⚽</span><ul>${scorers('away')}</ul></div>` : ''}
    ${tieLine(d)}
    <div class="jh-meta">${CUP_INFO[d.competition] ? `${CUP_INFO[d.competition].name} · ${escapeHtml(d.stageLabel)}${m.group ? ` · Grupo ${escapeHtml(m.group.replace('GROUP_', ''))}` : ''}` : `Brasileirão · Rodada ${m.matchday}`}${espn?.venue ? ` · ${escapeHtml(espn.venue.name)}${espn.venue.city ? `, ${escapeHtml(espn.venue.city)}` : ''}` : ''}</div>`;

  const tabs = JOGO_TABS.filter(([k]) => k !== 'tabela' || d.standings);
  if (!tabs.some(([k]) => k === state.jogo.tab)) state.jogo.tab = 'resumo';
  $('#jogo-back').href = isCup() ? `#/${state.comp}/jogos` : '#/jogos';
  $('#jogo-tabs').innerHTML = tabs.map(
    ([k, label]) => `<button data-t="${k}" class="${state.jogo.tab === k ? 'on' : ''}" aria-pressed="${state.jogo.tab === k}">${label}</button>`,
  ).join('');

  const body = { resumo: matchSummary, estatisticas: matchStats, escalacoes: matchLineups, confronto: matchH2H, tabela: matchTable }[state.jogo.tab];
  $('#jogo-body').innerHTML = body(d);
  growBars($('#jogo-body'));

  $('#jogo-fonte').innerHTML = espn
    ? `Estatísticas, lances, escalações e confronto: <a href="${escapeHtml(espn.url)}" target="_blank" rel="noopener">ESPN</a>. Previsões: modelo do painel.`
    : d.espnError
      ? `Não foi possível buscar estatísticas e escalações agora (${escapeHtml(d.espnError)}).`
      : 'Estatísticas e escalações não encontradas para este jogo.';
}

// Mata-mata: placar agregado e chance de passar
function tieLine(d) {
  const t = d.tie;
  if (!t || !t.teams[0]) return '';
  const [a, b] = t.teams;
  const agg = t.legs > 1 ? `Agregado: ${escapeHtml(a.shortName)} ${t.aggregate[0]} – ${t.aggregate[1]} ${escapeHtml(b.shortName)}` : '';
  const who = t.winner
    ? `${escapeHtml((t.winner === a.id ? a : b).shortName)} avançou`
    : t.advance != null
      ? `Chance de avançar: ${escapeHtml(a.shortName)} ${pct(t.advance)} · ${escapeHtml(b.shortName)} ${pct(1 - t.advance)}`
      : '';
  return `<div class="jh-tie">${[agg, who].filter(Boolean).join(' · ')}</div>`;
}

function timeline(d) {
  const { espn, match: m } = d;
  const events = espn?.events ?? [];
  if (!events.length) return '';
  return `<div class="card-j"><h3>Lances</h3><ol class="timeline">${events
    .map((e) => {
      const team = e.side === 'home' ? m.home : m.away;
      const extra =
        e.type === 'sub'
          ? `<small><span class="entra">▲ ${escapeHtml(e.player)}</span> <span class="sai">▼ ${escapeHtml(e.other ?? '')}</span></small>`
          : `<b>${escapeHtml(e.player)}</b>${e.other && e.type !== 'own-goal' ? `<small>assistência: ${escapeHtml(e.other)}</small>` : ''}${e.type === 'penalty' ? '<small>pênalti</small>' : ''}${e.type === 'own-goal' ? '<small>gol contra</small>' : ''}${e.type === 'missed-penalty' ? '<small>pênalti perdido</small>' : ''}`;
      return `<li class="${e.side} ${e.type}"><span class="ev-min">${escapeHtml(e.minute)}</span>
        <div class="ev-txt">${EVENT_ICON[e.type] ?? ''}<div>${extra}<small class="ev-time">${escapeHtml(team.shortName)}</small></div></div></li>`;
    })
    .join('')}</ol></div>`;
}

function matchSummary(d) {
  const { match: m, espn } = d;
  let html = timeline(d);
  const p = m.prediction;
  if (p) {
    html += `<div class="card-j"><h3>${m.status === 'LIVE' ? 'Como deve terminar' : 'Previsão do modelo'}</h3>
      ${probBar(p)}
      <div class="problabels"><span><b>${pct(p.pHome)}</b> ${escapeHtml(m.home.shortName)}</span><span>Empate <b>${pct(p.pDraw)}</b></span><span>${escapeHtml(m.away.shortName)} <b>${pct(p.pAway)}</b></span></div>
      <p class="sub-j">Placares mais prováveis</p>
      <div class="placares-j">${d.topScores.map((s) => `<span class="chip"><b>${s.home} × ${s.away}</b> ${pct(s.p)}</span>`).join('')}</div>
      <p class="sub-j">Gols esperados: ${escapeHtml(m.home.tla)} ${p.expectedHome.toFixed(1).replace('.', ',')} × ${p.expectedAway.toFixed(1).replace('.', ',')} ${escapeHtml(m.away.tla)}</p>
      ${
        espn?.odds
          ? `<p class="sub-j">Casas de apostas (${escapeHtml(espn.odds.provider)})</p>
        ${probBar({ pHome: espn.odds.home, pDraw: espn.odds.draw, pAway: espn.odds.away }, 'mercado')}
        <div class="problabels"><span><b>${pct(espn.odds.home)}</b></span><span><b>${pct(espn.odds.draw)}</b></span><span><b>${pct(espn.odds.away)}</b></span></div>`
          : ''
      }</div>`;
  }
  if (d.stakes) html += stakesCard(d);
  if (!html) html = '<p class="muted">Sem lances registrados para este jogo.</p>';
  return html;
}

// "O que está em jogo": chances de cada time conforme o resultado
function stakesCard(d) {
  const { match: m, stakes } = d;
  const metrics = [
    ['title', 'Título'],
    ['libertadores', 'Libertadores'],
    ['relegation', 'Rebaixamento'],
  ];
  const col = (s, team) => {
    const relevant = metrics.filter(([k]) =>
      ['base', 'H', 'D', 'A'].some((x) => {
        const v = stakes[x][s][k];
        return v > 0.005 && v < 0.995;
      }),
    );
    const rows = s === 'home' ? [['H', 'Se vencer'], ['D', 'Se empatar'], ['A', 'Se perder']] : [['A', 'Se vencer'], ['D', 'Se empatar'], ['H', 'Se perder']];
    if (!relevant.length) return `<div class="stake-time"><h4>${crestImg(team)}${escapeHtml(team.shortName)}</h4><p class="muted">Nada muda muito: título, vaga e queda já estão praticamente definidos.</p></div>`;
    return `<div class="stake-time"><h4>${crestImg(team)}${escapeHtml(team.shortName)}</h4>
      <table><thead><tr><th></th>${relevant.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>
      <tr class="hoje"><td class="left">Hoje</td>${relevant.map(([k]) => `<td>${pct(stakes.base[s][k])}</td>`).join('')}</tr>
      ${rows
        .map(
          ([x, label]) =>
            `<tr><td class="left">${label}</td>${relevant.map(([k]) => `<td>${pct(stakes[x][s][k])} ${delta(stakes[x][s][k], stakes.base[s][k], { badUp: k === 'relegation' })}</td>`).join('')}</tr>`,
        )
        .join('')}
      </tbody></table></div>`;
  };
  return `<div class="card-j"><h3>O que está em jogo</h3>
    <div class="stakes">${col('home', m.home)}${col('away', m.away)}</div></div>`;
}

function statBars(rows, colors) {
  return rows
    .map(({ label, home, away, display }) => {
      const total = home + away;
      const ph = total ? home / total : 0.5;
      const better = home === away ? '' : home > away ? 'home' : 'away';
      return `<div class="stat-j">
        <div class="stat-j-top"><b class="${better === 'home' ? 'mais' : ''}">${display[0]}</b><span>${label}</span><b class="${better === 'away' ? 'mais' : ''}">${display[1]}</b></div>
        <div class="stat-j-bar"><div class="h"><div data-w="${ph}" style="background:${colors.home.bg}"></div></div><div class="a"><div data-w="${1 - ph}" style="background:${colors.away.bg}"></div></div></div>
      </div>`;
    })
    .join('');
}

function matchStats(d) {
  const { match: m, espn } = d;
  const colors = matchColors(espn);
  const legend = `<div class="stat-legenda"><span>${crestImg(m.home)}${escapeHtml(m.home.shortName)}</span><span>${escapeHtml(m.away.shortName)}${crestImg(m.away)}</span></div>`;
  if (espn?.stats.length) return `<div class="card-j">${legend}${statBars(espn.stats, colors)}</div>`;

  // Antes do jogo: comparação da temporada (no mata-mata da Libertadores não há tabela)
  const h = d.home.standing;
  const a = d.away.standing;
  if (!h || !a) return '<div class="card-j vazio-j"><h3>Estatísticas</h3><p>As estatísticas do jogo aparecem quando a bola rolar.</p></div>';
  const per = (x, n) => (n ? x / n : 0);
  const fmt1 = (x) => x.toFixed(1).replace('.', ',');
  const rows = [
    ['Pontos', h.points, a.points],
    ['Vitórias', h.won, a.won],
    ['Aproveitamento', per(h.points, h.played * 3), per(a.points, a.played * 3), (x) => `${Math.round(x * 100)}%`],
    ['Gols marcados por jogo', per(h.goalsFor, h.played), per(a.goalsFor, a.played), fmt1],
    ['Gols sofridos por jogo', per(h.goalsAgainst, h.played), per(a.goalsAgainst, a.played), fmt1],
    ['Saldo de gols', h.goalDiff, a.goalDiff],
  ].map(([label, hv, av, f = String]) => ({ label, home: Math.max(0, hv), away: Math.max(0, av), display: [f(hv), f(av)] }));
  const leaders = espn && (espn.leaders.home.length || espn.leaders.away.length)
    ? `<div class="card-j"><h3>Destaques da temporada</h3><div class="destaques">${['home', 'away']
        .map((s) => `<div><h4>${crestImg(m[s])}${escapeHtml(m[s].shortName)}</h4><dl>${espn.leaders[s].map((l) => `<dt>${l.label}</dt><dd>${escapeHtml(l.name)} <b>${escapeHtml(l.value)}</b></dd>`).join('')}</dl></div>`)
        .join('')}</div></div>`
    : '';
  return `<div class="card-j"><h3>Na temporada</h3><p class="muted">As estatísticas do jogo aparecem quando a bola rolar.</p>${legend}${statBars(rows, colors)}</div>${leaders}`;
}

// Organiza os titulares em linhas pela formação ("4-2-3-1") e pela posição de cada um
function formationRows(lineup) {
  const counts = (lineup.formation ?? '').split('-').map(Number).filter((n) => n > 0);
  const gk = lineup.starters.find((p) => p.position === 'G' || p.place === 1);
  const outfield = lineup.starters.filter((p) => p !== gk);
  if (!gk || counts.reduce((s, n) => s + n, 0) !== outfield.length) return null;
  const depth = (pos) =>
    /^(LB|RB|CB|CD|SW|LWB|RWB|WB)/.test(pos) ? 1 : /^(DM|CDM)/.test(pos) ? 2 : /^(CM|LM|RM|M)/.test(pos) ? 3 : /^(AM|LW|RW|W)/.test(pos) ? 4 : /^(F|CF|ST|SS)/.test(pos) ? 5 : 3;
  const lateral = (pos) => (/^L/.test(pos) ? -2 : /-L$/.test(pos) ? -1 : /^R/.test(pos) ? 2 : /-R$/.test(pos) ? 1 : 0);
  const sorted = [...outfield].sort((a, b) => depth(a.position) - depth(b.position) || a.place - b.place);
  const rows = [[gk]];
  let i = 0;
  for (const n of counts) {
    rows.push(sorted.slice(i, i + n).sort((a, b) => lateral(a.position) - lateral(b.position) || a.place - b.place));
    i += n;
  }
  return rows;
}

function matchLineups(d) {
  const { match: m, espn } = d;
  if (!espn?.lineups) {
    return `<div class="card-j vazio-j"><h3>Escalações</h3><p>As escalações costumam sair cerca de <b>1 hora antes</b> do jogo. Volte mais perto do horário.</p></div>`;
  }
  const colors = matchColors(espn);
  // Quantos gols e cartões cada jogador teve, e quando saiu ou entrou
  const marks = new Map();
  const mark = (name, html) => marks.set(name, (marks.get(name) ?? '') + html);
  for (const e of espn.events) {
    if (['goal', 'penalty'].includes(e.type)) mark(e.player, '<i class="m-gol">⚽</i>');
    if (e.type === 'own-goal') mark(e.player, '<i class="m-gol contra">⚽</i>');
    if (e.type === 'yellow') mark(e.player, '<i class="cartao amarelo"></i>');
    if (e.type === 'red') mark(e.player, '<i class="cartao vermelho"></i>');
    if (e.type === 'sub') {
      mark(e.player, `<i class="m-sub entra">▲${escapeHtml(e.minute)}</i>`);
      if (e.other) mark(e.other, `<i class="m-sub sai">▼${escapeHtml(e.minute)}</i>`);
    }
  }
  const dot = (p, c) => `<div class="jog"><span class="num" style="background:${c.bg};color:${c.fg}">${escapeHtml(p.number)}</span>
    <span class="nome">${escapeHtml(p.name)}</span><span class="marcas">${marks.get(p.fullName) ?? ''}</span></div>`;

  const half = (s) => {
    const lineup = espn.lineups[s];
    const rows = formationRows(lineup);
    if (!rows) return null;
    // Visitante no topo atacando para baixo: inverte linhas e lados
    const ordered = s === 'home' ? [...rows].reverse() : rows.map((r) => [...r].reverse());
    return `<div class="meio ${s}">${ordered.map((r) => `<div class="linha-j">${r.map((p) => dot(p, colors[s])).join('')}</div>`).join('')}</div>`;
  };
  const top = half('away');
  const bottom = half('home');
  const pitch =
    top && bottom
      ? `<div class="campo-j">
      <div class="campo-rot">${crestImg(m.away)}${escapeHtml(m.away.shortName)} <small>${escapeHtml(espn.lineups.away.formation ?? '')}</small></div>
      <div class="gramado-j">${top}<div class="meio-campo"></div>${bottom}</div>
      <div class="campo-rot">${crestImg(m.home)}${escapeHtml(m.home.shortName)} <small>${escapeHtml(espn.lineups.home.formation ?? '')}</small></div>
    </div>`
      : '';

  const list = (s) => {
    const l = espn.lineups[s];
    const item = (p) => `<li><span class="num-s">${escapeHtml(p.number)}</span>${escapeHtml(p.name)} <span class="pos-s">${escapeHtml(p.position === 'SUB' ? '' : p.position)}</span><span class="marcas">${marks.get(p.fullName) ?? ''}</span></li>`;
    return `<div><h4>${crestImg(m[s])}${escapeHtml(m[s].shortName)}</h4>
      ${pitch ? '' : `<p class="sub-j">Titulares</p><ul class="lista-j">${l.starters.map(item).join('')}</ul>`}
      <p class="sub-j">Reservas</p><ul class="lista-j">${l.bench.map(item).join('')}</ul></div>`;
  };
  return `${pitch ? `<div class="card-j">${pitch}</div>` : ''}<div class="card-j"><div class="reservas">${list('home')}${list('away')}</div></div>`;
}

function matchH2H(d) {
  const { match: m, espn } = d;
  const last = (s) => `<div><h4>${crestImg(m[s])}${escapeHtml(m[s].shortName)}</h4><ul class="ultimos-j">${d[s].last
    .map(
      (r) => `<li><span class="form"><span class="${r.result}">${r.result}</span></span>
      <span>${r.home ? 'x' : '@'} ${crestImg(r.opponent)} ${escapeHtml(r.opponent.shortName)}</span>
      <b>${r.goalsFor}–${r.goalsAgainst}</b></li>`,
    )
    .join('')}</ul></div>`;

  let h2h = '';
  if (espn?.h2h.length) {
    const count = (w) => espn.h2h.filter((g) => g.winner === w).length;
    const [wh, dr, wa] = [count('home'), count(null), count('away')];
    const rows = espn.h2h.map((g) => {
      const date = new Date(g.date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      return `<li><small>${date}${g.competition ? ` · ${escapeHtml(g.competition)}` : ''}</small>
        <span class="h2h-l">${escapeHtml(g.homeName)}</span><b>${g.homeScore ?? '-'} – ${g.awayScore ?? '-'}</b><span class="h2h-r">${escapeHtml(g.awayName)}</span></li>`;
    });
    h2h = `<div class="card-j"><h3>Confronto direto</h3>
      <div class="h2h-resumo"><div><b>${wh}</b><span>${escapeHtml(m.home.shortName)}</span></div><div><b>${dr}</b><span>Empates</span></div><div><b>${wa}</b><span>${escapeHtml(m.away.shortName)}</span></div></div>
      <p class="sub-j">Últimos ${espn.h2h.length} jogos entre os dois</p><ul class="h2h">${rows.join('')}</ul></div>`;
  }
  return `${h2h}<div class="card-j"><h3>Últimos jogos</h3><div class="reservas">${last('home')}${last('away')}</div></div>`;
}

function matchTable(d) {
  const { match: m } = d;
  const total = d.standings.length;
  const zone = (pos) => (pos <= d.zones.libertadores ? 'lib' : pos <= d.zones.sulamericana ? 'sul' : pos > total - d.zones.relegation ? 'reb' : '');
  return `<div class="table-wrap"><table class="standings mini-tab"><thead><tr><th>#</th><th class="left">Time</th><th>P</th><th>J</th><th>SG</th></tr></thead><tbody>${d.standings
    .map(
      (r) => `<tr class="${zone(r.position)} ${r.team.id === m.home.id || r.team.id === m.away.id ? 'destaque-t' : ''}">
      <td class="pos">${r.position}</td><td class="left">${teamHtml(r.team)}</td><td class="points">${r.points}</td><td>${r.played}</td><td>${r.goalDiff > 0 ? '+' : ''}${r.goalDiff}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}

$('#jogo-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-t]');
  if (!b) return;
  state.jogo.tab = b.dataset.t;
  renderMatchPage();
});

// ---------- Libertadores ----------

state.lib = { stage: null };

async function libMeta() {
  const o = await api(cupApi('/overview'));
  const updated = new Date(o.updatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  $('#meta').textContent = `${CUP_INFO[state.comp].title} · ${o.currentStage.label} · fonte: ${o.source} · atualizado às ${updated}`;
  $(`#${state.comp}-fase`).textContent = o.currentStage.label;
  return o;
}

// Linha de um time dentro do cartão do confronto
function tieTeam(t, goals, won, chance) {
  if (!t) return `<div class="tt tbd"><span class="badge">?</span><span>A definir</span></div>`;
  return `<div class="tt ${won ? 'passou' : ''}">${crestImg(t)}<a href="${teamHref(t.id)}">${escapeHtml(t.shortName)}</a>
    ${chance != null ? `<small class="chance-t">${pct(chance)}</small>` : ''}<b>${goals ?? ''}</b></div>`;
}

function tieCard(t, champions) {
  const [a, b] = t.teams;
  const legs = t.legs
    .map((l) => {
      const played = l.status === 'FINISHED' || l.status === 'LIVE';
      const date = new Date(l.utcDate).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
      const pen = l.penalties ? ` (pên. ${l.penalties[0]}–${l.penalties[1]})` : '';
      if (l.home.tbd) return `<span class="perna">${date} · jogo único, campo neutro</span>`;
      return `<a href="${jogoHref(l.id)}" class="perna">${played ? `${escapeHtml(l.home.tla)} ${l.homeGoals}–${l.awayGoals} ${escapeHtml(l.away.tla)}${pen}` : `${date} · ${escapeHtml(l.home.tla)} x ${escapeHtml(l.away.tla)}`}${l.status === 'LIVE' ? ' <span class="live-tag">●</span>' : ''}</a>`;
    })
    .join('');
  // Final ainda sem os dois times: mostra quem tem mais chance de chegar
  const finalists =
    !a && champions?.length
      ? `<div class="provaveis">${champions
          .filter((c) => c.final > 0.005)
          .map((c) => `<span>${crestImg(c.team)}${escapeHtml(c.team.shortName)} <b>${pct(c.final)}</b></span>`)
          .join('')}</div>`
      : '';
  const played = t.legs.some((l) => l.status === 'FINISHED' || l.status === 'LIVE');
  return `<div class="tie ${t.winner ? 'decidido' : ''}">
    ${tieTeam(a, played && a ? t.aggregate[0] : null, t.winner === a?.id, t.advance)}
    ${tieTeam(b, played && b ? t.aggregate[1] : null, t.winner === b?.id, t.advance != null ? 1 - t.advance : null)}
    ${finalists}
    <div class="pernas">${legs}</div>
  </div>`;
}

async function loadLibBracket() {
  const o = await libMeta();
  $('#lib-campeao').innerHTML = `<div class="corrida-card">${o.champions
    .map(
      (c) => `<div class="linha">${crestImg(c.team)}
      <div class="trilho" style="--c:var(--amarelo)"><div data-w="${c.champion}"></div><span><a href="${teamHref(c.team.id)}">${escapeHtml(c.team.shortName)}</a></span></div>
      <b>${pct(c.champion)}</b></div>`,
    )
    .join('')}</div>`;
  $('#lib-bracket').innerHTML = o.stages
    .map((s) => `<div class="fase-col"><h3>${escapeHtml(s.label)}</h3><div class="fase-ties">${s.ties.map((t) => tieCard(t, s.key === 'FINAL' ? o.champions : null)).join('')}</div></div>`)
    .join('');
  $('#cup-slogan').textContent = CUP_INFO[state.comp].slogan;
  const jogos = state.comp === 'cdb' ? 'da Copa do Brasil e do Brasileirão' : 'da Libertadores';
  $('#lib-nota').textContent = `Chances calculadas com ${o.simulations.toLocaleString('pt-BR')} simulações do mata-mata, usando o modelo ajustado com os jogos ${jogos}. A final é em jogo único, em campo neutro.`;
  growBars($('#lib-chave'));
}

async function loadLibMatches() {
  const data = await api(cupApi(`/matches${state.lib.stage ? `?stage=${state.lib.stage}` : ''}`));
  state.lib.stage = data.stage.key;
  libMeta().catch(() => {});
  $('#lib-fases').innerHTML = data.stages
    .map((s) => `<button data-stage="${s.key}" class="${s.key === data.stage.key ? 'on' : ''}">${escapeHtml(s.label)}</button>`)
    .join('');
  // Na fase de grupos, separa os jogos por rodada
  const cards = data.matches.map((m) => matchCard(m, data.watchUrl));
  $('#lib-matches').innerHTML = cards.length ? cards.join('') : '<div class="empty">Sem jogos nesta fase.</div>';
  growBars($('#lib-matches'));
}

async function loadLibGroups() {
  const data = await api(cupApi('/groups'));
  libMeta().catch(() => {});
  $('#lib-groups').innerHTML = data.groups
    .map(
      (g) => `<div class="grupo"><h3>Grupo ${escapeHtml(g.group)}</h3><div class="table-wrap"><table class="standings mini-tab">
      <thead><tr><th>#</th><th class="left">Time</th><th>P</th><th>J</th><th>SG</th><th>Últimos</th></tr></thead><tbody>${g.rows
        .map(
          (r) => `<tr class="${r.position <= data.zones.libertadores ? 'lib' : r.position <= data.zones.sulamericana ? 'sul' : ''}">
          <td class="pos">${r.position}</td><td class="left">${teamHtml(r.team)}</td><td class="points">${r.points}</td><td>${r.played}</td>
          <td>${r.goalDiff > 0 ? '+' : ''}${r.goalDiff}</td><td><span class="form">${r.form.map((x, i) => formLink(x, r.formMatches[i])).join('')}</span></td></tr>`,
        )
        .join('')}</tbody></table></div></div>`,
    )
    .join('');
}

async function loadLibScorers() {
  const data = await api(cupApi('/scorers'));
  libMeta().catch(() => {});
  $('#lib-scorers').innerHTML = scorersTable(data.scorers);
}

$('#lib-fases').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-stage]');
  if (!b) return;
  state.lib.stage = b.dataset.stage;
  refresh();
});

// Página de um time da Libertadores (qualquer clube, brasileiro ou não)
const JOURNEY_LABEL = { passou: 'Passou', eliminado: 'Eliminado' };

function journeyStep(s) {
  if (s.stage === 'GROUP_STAGE') {
    const status = s.result === 'passou' ? 'passou' : s.result === 'eliminado' ? 'eliminado' : 'aberto';
    const note = s.result === 'passou' ? 'Classificado' : s.sulamericana ? 'Foi para a Sul-Americana' : s.result === 'eliminado' ? 'Eliminado' : 'Em disputa';
    return `<div class="passo ${status}"><small>${escapeHtml(s.label)}</small>
      <b>${s.position}º no Grupo ${escapeHtml(s.group)}</b><span>${s.points} pontos · ${note}</span></div>`;
  }
  if (s.reach != null) {
    return `<div class="passo futuro"><small>${escapeHtml(s.label)}</small><b>Chance de chegar</b><span>${pct(s.reach)}</span></div>`;
  }
  const opp = s.opponent ? `${crestImg(s.opponent)} ${escapeHtml(s.opponent.shortName)}` : 'A definir';
  const status = s.result ?? 'aberto';
  const placar = s.played ? `<em>${s.aggregate[0]} – ${s.aggregate[1]}</em>` : '';
  const note = s.result ? JOURNEY_LABEL[s.result] : s.advance != null ? `Chance de passar: ${pct(s.advance)}` : 'Em disputa';
  return `<div class="passo ${status}"><small>${escapeHtml(s.label)}</small><b>${opp} ${placar}</b><span>${note}</span></div>`;
}

async function loadLibTeam() {
  const d = await api(cupApi(`/time/${state.lib.teamId}`));
  libMeta().catch(() => {});
  const t = d.team;
  const cup = CUP_INFO[state.comp].name;
  document.title = `${t.shortName} · ${cup}`;
  $('#lib-time-back').href = cup === 'Libertadores' ? '#/lib/grupos' : `#/${state.comp}/chave`;
  $('#lib-time-back').textContent = `← ${cup}`;
  $('#lib-team-caminho').textContent = `Caminho na ${cup}`;
  const out = d.journey.find((s) => s.result === 'eliminado');
  const won = d.journey.find((s) => s.stage === 'FINAL' && s.result === 'passou');
  const situation = won
    ? `Campeão da ${cup}`
    : out
      ? `Eliminado: ${out.label.toLowerCase()}${out.sulamericana ? ' (foi para a Sul-Americana)' : ''}`
      : `Na disputa · ${pct(d.champion)} de chance de título`;
  const icon = t.crest ? `<img class="crest big" src="${escapeHtml(t.crest)}" alt="" />` : `<span class="badge big">${escapeHtml(t.tla)}</span>`;
  $('#lib-team-header').innerHTML = `${icon}<div><h2>${escapeHtml(t.name)}</h2><p class="muted">${situation}</p></div>`;

  const s = d.stats;
  const r = d.ratings;
  const rating = (v, kind) => ratingText(v, kind).replace('da liga', `da ${cup}`);
  $('#lib-team-stats').innerHTML = [
    statCard('Campanha', `${s.won}V ${s.drawn}E ${s.lost}D`, `${s.played} jogos · ${s.goalsFor} gols marcados, ${s.goalsAgainst} sofridos`),
    statCard('Chance de título', pct(d.champion), out ? 'já foi eliminado' : 'pelas simulações do mata-mata'),
    statCard('Ataque', `${r.attackRank}º`, `de ${r.of} times · ${rating(r.attack, 'attack')}`),
    statCard('Defesa', `${r.defenseRank}º`, `de ${r.of} times · ${rating(r.defense, 'defense')}`),
  ].join('');

  $('#lib-team-journey').innerHTML = d.journey.length ? d.journey.map(journeyStep).join('') : '<div class="empty">Sem jogos ainda.</div>';

  $('#lib-team-upcoming-box').hidden = !d.upcoming.length;
  $('#lib-team-upcoming').innerHTML = d.upcoming.map((m) => matchCard(m, d.watchUrl)).join('');

  $('#lib-team-group-box').hidden = !d.group;
  if (d.group) {
    $('#lib-team-group-title').textContent = `Grupo ${d.group.name}`;
    $('#lib-team-group').innerHTML = `<div class="table-wrap"><table class="standings mini-tab">
      <thead><tr><th>#</th><th class="left">Time</th><th>P</th><th>J</th><th>SG</th></tr></thead><tbody>${d.group.rows
        .map((row) => {
          const zone = row.position <= d.zones.libertadores ? 'lib' : row.position <= d.zones.sulamericana ? 'sul' : '';
          return `<tr class="${zone} ${row.team.id === t.id ? 'eu' : ''}">
          <td class="pos">${row.position}</td><td class="left">${teamHtml(row.team)}</td><td class="points">${row.points}</td><td>${row.played}</td>
          <td>${row.goalDiff > 0 ? '+' : ''}${row.goalDiff}</td></tr>`;
        })
        .join('')}</tbody></table></div>`;
  }
  $('#lib-team-scorers').innerHTML = d.scorers.length
    ? `<div class="table-wrap"><table><thead><tr><th class="left">Jogador</th><th>Gols</th><th>Assist.</th></tr></thead><tbody>${d.scorers
        .map((p) => `<tr><td class="left">${escapeHtml(p.player)}</td><td class="points">${p.goals}</td><td>${p.assists ?? '–'}</td></tr>`)
        .join('')}</tbody></table></div>`
    : '<div class="empty">Nenhum jogador do time entre os artilheiros da competição.</div>';

  $('#lib-team-results').innerHTML = d.results.length
    ? `<div class="table-wrap"><table>
    <thead><tr><th>Fase</th><th>Data</th><th class="left">Adversário</th><th>Placar</th><th></th></tr></thead>
    <tbody>${d.results
      .map((res) => {
        const m = res.match;
        const date = new Date(m.utcDate).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        const pen = m.penalties ? ` <small>(pên. ${m.penalties[0]}–${m.penalties[1]})</small>` : '';
        const score = `${m.home.tla} ${m.homeGoals}×${m.awayGoals} ${m.away.tla}`;
        return `<tr class="linha-jogo" data-jogo="${m.id}">
          <td>${escapeHtml(res.stageLabel)}</td>
          <td>${date}</td>
          <td class="left"><span class="matchup">${teamHtml(res.opponent)} <span class="venue">${res.home ? 'casa' : 'fora'}</span></span></td>
          <td class="points">${escapeHtml(m.home.tla)} ${m.homeGoals} × ${m.awayGoals} ${escapeHtml(m.away.tla)}${pen}</td>
          <td><span class="form">${formLink(res.result, { id: m.id, score })}</span></td>
        </tr>`;
      })
      .join('')}</tbody></table></div>`
    : '<div class="empty">Nenhum jogo encerrado ainda.</div>';
}

// ---------- Simulador "e se" ----------

// Preferências do aparelho (palpites, time do coração): podem não existir em aba anônima.
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // sem armazenamento: vale só enquanto a página estiver aberta
    }
  },
};

state.ese = { data: null, matchday: null, picks: store.get('ese.picks', {}), result: null, timer: null, seq: 0 };

const PICK_LABEL = { H: 'Casa', D: 'Empate', A: 'Fora' };

async function loadWhatif() {
  const ese = state.ese;
  ese.data = await api('/api/whatif');
  const pendingIds = new Set(ese.data.matches.map((m) => String(m.id)));
  // Jogo que já terminou de verdade sai dos palpites
  for (const id of Object.keys(ese.picks)) if (!pendingIds.has(id)) delete ese.picks[id];

  const rounds = [...new Set(ese.data.matches.map((m) => m.matchday))];
  if (!rounds.includes(ese.matchday)) ese.matchday = rounds.includes(ese.data.currentMatchday) ? ese.data.currentMatchday : (rounds[0] ?? null);

  const select = $('#ese-team');
  if (select.options.length <= 1) {
    const teams = [...ese.data.standings].sort((a, b) => a.team.shortName.localeCompare(b.team.shortName, 'pt-BR'));
    select.insertAdjacentHTML('beforeend', teams.map((r) => `<option value="${r.team.id}">${escapeHtml(r.team.shortName)}</option>`).join(''));
    select.value = String(store.get('meuTime', '') ?? '');
  }
  renderWhatifMatches();
  await recalcWhatif();
}

function renderWhatifMatches() {
  const ese = state.ese;
  const rounds = [...new Set(ese.data.matches.map((m) => m.matchday))];
  const i = rounds.indexOf(ese.matchday);
  $('#ese-round').textContent = ese.matchday ? `Rodada ${ese.matchday}` : 'Sem jogos';
  $('#ese-prev').disabled = i <= 0;
  $('#ese-next').disabled = i < 0 || i >= rounds.length - 1;

  const myTeam = Number($('#ese-team').value) || null;
  $('#ese-matches').innerHTML = ese.data.matches
    .filter((m) => m.matchday === ese.matchday)
    .map((m) => {
      const pick = ese.picks[m.id];
      const p = m.prediction;
      const live = m.status === 'LIVE';
      const date = new Date(m.utcDate);
      const when = live
        ? `<span class="live-tag">● ${m.homeGoals ?? 0} × ${m.awayGoals ?? 0} ${m.minute ? `${m.minute}'` : ''}</span>`
        : `${date.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })} · ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
      const mine = myTeam && (m.home.id === myTeam || m.away.id === myTeam);
      const btn = (k, chance) =>
        `<button data-id="${m.id}" data-p="${k}" class="${pick === k ? 'on' : ''}" aria-pressed="${pick === k}">${PICK_LABEL[k]}<small>${pct(chance)}</small></button>`;
      return `<div class="ese-jogo ${pick ? 'escolhido' : ''} ${mine ? 'meu' : ''}">
        <div class="ese-times">
          <span class="lado-a">${crestImg(m.home)}<b>${escapeHtml(m.home.shortName)}</b></span>
          <small>${when}</small>
          <span class="lado-b"><b>${escapeHtml(m.away.shortName)}</b>${crestImg(m.away)}</span>
        </div>
        <div class="seg3">${btn('H', p.pHome)}${btn('D', p.pDraw)}${btn('A', p.pAway)}</div>
      </div>`;
    })
    .join('');

  const n = Object.keys(ese.picks).length;
  $('#ese-count').textContent = n ? `${n} jogo${n > 1 ? 's' : ''} escolhido${n > 1 ? 's' : ''}` : 'Nenhum jogo escolhido';
  $('#ese-clear').hidden = !n;
}

// Espera um instante depois do último toque antes de recalcular
function scheduleWhatif() {
  clearTimeout(state.ese.timer);
  $('#ese-status').textContent = 'calculando…';
  state.ese.timer = setTimeout(() => recalcWhatif().catch((err) => showBanner(err.message, true)), 250);
}

async function recalcWhatif() {
  const ese = state.ese;
  const seq = ++ese.seq;
  $('#ese-status').textContent = 'calculando…';
  const res = await fetch('/api/whatif', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ picks: ese.picks }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Erro ${res.status}`);
  if (seq !== ese.seq) return; // já chegou um pedido mais novo
  ese.result = body;
  $('#ese-status').textContent = '';
  renderWhatifResult();
}

// Diferença em pontos percentuais (ou em pontos); `badUp` = subir é ruim (rebaixamento)
function delta(now, before, { badUp = false, points = false } = {}) {
  const d = points ? now - before : (now - before) * 100;
  if (Math.abs(d) < (points ? 0.05 : 0.5)) return '';
  const good = badUp ? d < 0 : d > 0;
  const txt = points ? d.toFixed(1).replace('.', ',') : Math.round(d);
  return `<span class="delta ${good ? 'bom' : 'ruim'}">${d > 0 ? '▲ +' : '▼ '}${txt}</span>`;
}

function renderWhatifResult() {
  const ese = state.ese;
  const teamsById = new Map(ese.data.standings.map((r) => [r.team.id, r.team]));
  const before = new Map(ese.result.base.map((o) => [o.teamId, { team: teamsById.get(o.teamId), outlook: o }]));
  const myTeam = Number($('#ese-team').value) || null;
  const rows = ese.result.teams
    .map((o) => ({ o, base: before.get(o.teamId) }))
    .sort((a, b) => b.o.expectedPoints - a.o.expectedPoints);

  $('#ese-body').innerHTML = rows
    .map(({ o, base }) => {
      const b = base.outlook;
      return `<tr class="${o.teamId === myTeam ? 'meu' : ''}">
        <td class="left">${teamHtml(base.team)}</td>
        <td>${o.expectedPoints.toFixed(1).replace('.', ',')} ${delta(o.expectedPoints, b.expectedPoints, { points: true })}</td>
        <td>${pct(o.title)} ${delta(o.title, b.title)}</td>
        <td>${pct(o.libertadores)} ${delta(o.libertadores, b.libertadores)}</td>
        <td>${pct(o.relegation)} ${delta(o.relegation, b.relegation, { badUp: true })}</td>
      </tr>`;
    })
    .join('');

  const focus = rows.find((r) => r.o.teamId === myTeam);
  $('#ese-focus').innerHTML = focus
    ? `<div class="ese-meu">${crestImg(focus.base.team)}<b>${escapeHtml(focus.base.team.shortName)}</b></div>
      ${[
        ['Pontos projetados', focus.o.expectedPoints.toFixed(1).replace('.', ','), delta(focus.o.expectedPoints, focus.base.outlook.expectedPoints, { points: true })],
        ['Título', pct(focus.o.title), delta(focus.o.title, focus.base.outlook.title)],
        ['Libertadores', pct(focus.o.libertadores), delta(focus.o.libertadores, focus.base.outlook.libertadores)],
        ['Rebaixamento', pct(focus.o.relegation), delta(focus.o.relegation, focus.base.outlook.relegation, { badUp: true })],
      ]
        .map(([label, value, d]) => `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div><div class="compare">${d || 'sem mudança'}</div></div>`)
        .join('')}`
    : '';
}

$('#ese-matches').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-p]');
  if (!btn) return;
  const { id, p } = btn.dataset;
  if (state.ese.picks[id] === p) delete state.ese.picks[id];
  else state.ese.picks[id] = p;
  store.set('ese.picks', state.ese.picks);
  renderWhatifMatches();
  scheduleWhatif();
});

$('#ese-clear').addEventListener('click', () => {
  state.ese.picks = {};
  store.set('ese.picks', {});
  renderWhatifMatches();
  scheduleWhatif();
});

$('#ese-team').addEventListener('change', (e) => {
  store.set('meuTime', e.target.value ? Number(e.target.value) : null);
  renderWhatifMatches();
  if (state.ese.result) renderWhatifResult();
});

function moveWhatifRound(step) {
  const rounds = [...new Set(state.ese.data.matches.map((m) => m.matchday))];
  const i = rounds.indexOf(state.ese.matchday) + step;
  if (i < 0 || i >= rounds.length) return;
  state.ese.matchday = rounds[i];
  renderWhatifMatches();
}
$('#ese-prev').addEventListener('click', () => moveWhatifRound(-1));
$('#ese-next').addEventListener('click', () => moveWhatifRound(1));

// ---------- Alertas de gol ----------

const ALERT_DEFAULTS = { on: false, all: false, teams: [], sound: true, vibrate: true, notify: false, kickoff: false };
const alerts = { ...ALERT_DEFAULTS, ...store.get('alertas', {}) };
// Placar de cada jogo na última leitura, para perceber o que mudou (gol, início, fim)
const lastSeen = new Map();
let audioCtx = null;
let swRegistration = null;

const canVibrate = 'vibrate' in navigator;
// Notificação do sistema só existe em endereço seguro (https ou localhost)
const canNotify = window.isSecureContext && 'Notification' in window && 'serviceWorker' in navigator;

if (canNotify) {
  navigator.serviceWorker.register('sw.js').then((reg) => (swRegistration = reg), () => {});
}

function saveAlerts() {
  store.set('alertas', alerts);
  $('.bell-dot').hidden = !alerts.on;
}

function follows(match) {
  return alerts.all || alerts.teams.includes(match.home.id) || alerts.teams.includes(match.away.id);
}

// O navegador só deixa tocar som depois de um toque do usuário: liga o áudio aqui
function unlockAudio() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {
    audioCtx = null;
  }
}

/** Apito de juiz: dois trinados curtos e um longo. */
function whistle(kind) {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  const blasts = kind === 'goal' ? [[0, 0.18], [0.25, 0.18], [0.5, 0.7]] : [[0, 0.5]];
  for (const [start, dur] of blasts) {
    const osc = audioCtx.createOscillator();
    const trill = audioCtx.createOscillator();
    const trillGain = audioCtx.createGain();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = 2900;
    trill.frequency.value = 38; // o "trinado" da bolinha do apito
    trillGain.gain.value = 260;
    trill.connect(trillGain).connect(osc.frequency);
    gain.gain.setValueAtTime(0.0001, t0 + start);
    gain.gain.exponentialRampToValueAtTime(0.12, t0 + start + 0.02);
    gain.gain.setValueAtTime(0.12, t0 + start + dur - 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0 + start);
    trill.start(t0 + start);
    osc.stop(t0 + start + dur);
    trill.stop(t0 + start + dur);
  }
}

function alertText(ev) {
  const { match: m } = ev;
  const score = `${m.home.shortName} ${m.homeGoals ?? 0} × ${m.awayGoals ?? 0} ${m.away.shortName}`;
  if (ev.type === 'goal') {
    const who = ev.side === 'home' ? m.home : m.away;
    return { title: `GOL do ${who.shortName}!`, body: `${score}${m.minute ? ` · ${m.minute}'` : ''}`, team: who };
  }
  if (ev.type === 'kickoff') return { title: 'Começou!', body: score, team: m.home };
  return { title: 'Fim de jogo', body: score, team: m.home };
}

function showToast(ev) {
  const { title, body, team } = alertText(ev);
  const el = document.createElement('a');
  el.href = '#/jogos';
  el.className = `toast ${ev.type}`;
  el.innerHTML = `${crestImg(team)}<div><b>${escapeHtml(title)}</b><span>${escapeHtml(body)}</span></div>`;
  el.addEventListener('click', () => el.remove());
  $('#toasts').prepend(el);
  setTimeout(() => el.classList.add('saindo'), 9000);
  setTimeout(() => el.remove(), 9600);
}

function fireAlert(ev) {
  if (ev.type !== 'goal' && !alerts.kickoff) return;
  showToast(ev);
  if (alerts.sound) whistle(ev.type);
  if (alerts.vibrate && canVibrate) navigator.vibrate(ev.type === 'goal' ? [300, 100, 300, 100, 700] : [200]);
  if (alerts.notify && canNotify && Notification.permission === 'granted' && document.hidden && swRegistration) {
    const { title, body, team } = alertText(ev);
    swRegistration.showNotification(title, { body, icon: team.crest, tag: `jogo-${ev.match.id}`, renotify: true, data: { url: '/#/jogos' } });
  }
}

/** Compara a leitura nova dos jogos com a anterior e avisa o que aconteceu. */
function checkAlerts(matches) {
  for (const m of matches) {
    const before = lastSeen.get(m.id);
    lastSeen.set(m.id, { status: m.status, h: m.homeGoals ?? 0, a: m.awayGoals ?? 0 });
    if (!before || !alerts.on || !follows(m)) continue;
    const h = m.homeGoals ?? 0;
    const a = m.awayGoals ?? 0;
    if (before.status === 'SCHEDULED' && m.status === 'LIVE') fireAlert({ type: 'kickoff', match: m });
    if (before.status === 'LIVE' || m.status === 'LIVE') {
      for (let g = before.h; g < h; g++) fireAlert({ type: 'goal', side: 'home', match: m });
      for (let g = before.a; g < a; g++) fireAlert({ type: 'goal', side: 'away', match: m });
    }
    if (before.status === 'LIVE' && m.status === 'FINISHED') fireAlert({ type: 'fulltime', match: m });
  }
}

function renderAlertDialog(teams) {
  $('#al-on').checked = alerts.on;
  $('#al-todos').checked = alerts.all;
  $('#al-som').checked = alerts.sound;
  $('#al-vibrar').checked = alerts.vibrate;
  $('#al-notif').checked = alerts.notify && canNotify;
  $('#al-inicio').checked = alerts.kickoff;
  $('#al-opcoes').classList.toggle('desligado', !alerts.on);
  $('#al-vibrar-row').hidden = !canVibrate;
  $('#al-notif').disabled = !canNotify;
  const info = $('#al-notif-info');
  info.hidden = canNotify && Notification.permission !== 'denied';
  info.textContent = !canNotify
    ? 'Notificação do sistema não está disponível neste endereço (precisa de https). O aviso na tela, o som e a vibração funcionam.'
    : 'As notificações foram bloqueadas neste navegador. Libere nas configurações do site.';
  $('#al-times').innerHTML = teams
    .map(
      (t) => `<button type="button" class="al-time ${alerts.teams.includes(t.id) ? 'on' : ''}" data-id="${t.id}" aria-pressed="${alerts.teams.includes(t.id)}">
        ${crestImg(t)}<span>${escapeHtml(t.shortName)}</span></button>`,
    )
    .join('');
  $('#al-times').classList.toggle('desligado', alerts.all);
}

async function openAlertDialog() {
  unlockAudio();
  const data = await api('/api/overview');
  const teams = data.standings.map((r) => r.team).sort((a, b) => a.shortName.localeCompare(b.shortName, 'pt-BR'));
  state.alertTeams = teams;
  renderAlertDialog(teams);
  $('#alert-dialog').showModal();
}

$('#bell').addEventListener('click', () => openAlertDialog().catch((err) => showBanner(err.message, true)));

$('#alert-dialog').addEventListener('change', async (e) => {
  const map = { 'al-on': 'on', 'al-todos': 'all', 'al-som': 'sound', 'al-vibrar': 'vibrate', 'al-notif': 'notify', 'al-inicio': 'kickoff' };
  const key = map[e.target.id];
  if (!key) return;
  alerts[key] = e.target.checked;
  if (key === 'notify' && alerts.notify && Notification.permission === 'default') {
    alerts.notify = (await Notification.requestPermission()) === 'granted';
  }
  // Ligou e não escolheu nenhum time: começa avisando de todos
  if (key === 'on' && alerts.on && !alerts.all && !alerts.teams.length) alerts.all = true;
  unlockAudio();
  saveAlerts();
  renderAlertDialog(state.alertTeams);
});

$('#al-times').addEventListener('click', (e) => {
  const btn = e.target.closest('.al-time');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  alerts.teams = alerts.teams.includes(id) ? alerts.teams.filter((x) => x !== id) : [...alerts.teams, id];
  alerts.all = false;
  saveAlerts();
  renderAlertDialog(state.alertTeams);
});

$('#al-testar').addEventListener('click', () => {
  unlockAudio();
  const t = state.alertTeams;
  const home = t.find((x) => alerts.teams.includes(x.id)) ?? t[0];
  const away = t.find((x) => x.id !== home.id);
  // A caixa de configuração fica por cima de tudo: fecha antes para o aviso aparecer
  $('#alert-dialog').close();
  setTimeout(() => fireAlert({ type: 'goal', side: 'home', match: { id: 0, home, away, homeGoals: 1, awayGoals: 0, minute: 23 } }), 300);
});

// Clicar fora da caixa fecha
$('#alert-dialog').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});

saveAlerts();

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
  jogo: loadMatchPage,
  'lib-chave': loadLibBracket,
  'lib-jogos': loadLibMatches,
  'lib-grupos': loadLibGroups,
  'lib-gols': loadLibScorers,
  'lib-time': loadLibTeam,
  ese: loadWhatif,
};

async function refresh() {
  try {
    const hero = loadHero();
    if (state.comp === 'bsa' && !state.metaSet && state.tab !== 'tabela') api('/api/overview').then(setMeta, () => {});
    if (isCup() && state.tab === 'jogo') libMeta().catch(() => {});
    await loaders[state.tab]();
    await hero;
  } catch (err) {
    showBanner(`Não foi possível carregar os dados: ${err.message}`, true);
  }
}

// Navegação pelo endereço: #/jogos, #/time/12 etc. (o botão "voltar" do navegador funciona)
const LIB_PAGES = ['chave', 'jogos', 'grupos', 'gols'];

function applyRoute() {
  const [page, id, , vsId] = location.hash.replace(/^#\/?/, '').split('/');
  const comp = page in CUP_INFO ? page : 'bsa';
  if (comp !== state.comp) {
    state.comp = comp;
    state.lib.stage = null;
    state.metaSet = false;
    state.heroHtml = null;
    state.jogo.data = null;
    $('#meta').textContent = 'Carregando…';
  }
  if (isCup()) {
    // #/lib/chave, #/cdb/jogos, #/lib/jogo/123, #/cdb/time/45...
    const jogoId = Number(location.hash.split('/')[3]);
    if (id === 'time' && jogoId) {
      state.tab = 'lib-time';
      if (state.lib.teamId !== jogoId) window.scrollTo(0, 0);
      state.lib.teamId = jogoId;
    } else if (id === 'jogo' && jogoId) {
      state.tab = 'jogo';
      if (state.jogo.id !== jogoId) {
        state.jogo.tab = 'resumo';
        window.scrollTo(0, 0);
      }
      state.jogo.id = jogoId;
    } else {
      const pages = CUP_INFO[comp].groups ? LIB_PAGES : ['chave', 'jogos'];
      state.tab = `lib-${pages.includes(id) ? id : 'chave'}`;
      document.title = `${CUP_INFO[comp].name} · Painel`;
    }
  } else if (page === 'time' && Number(id)) {
    state.tab = 'time';
    state.teamId = Number(id);
    window.scrollTo(0, 0);
  } else if (page === 'jogo' && Number(id)) {
    state.tab = 'jogo';
    if (state.jogo.id !== Number(id)) {
      state.jogo.tab = 'resumo';
      window.scrollTo(0, 0);
    }
    state.jogo.id = Number(id);
  } else if (page === 'jogador' && Number(id)) {
    // #/jogador/12 ou #/jogador/12/vs/34
    state.tab = 'jogador';
    if (state.playerId !== Number(id)) window.scrollTo(0, 0);
    state.playerId = Number(id);
    state.compareId = Number(vsId) || null;
  } else {
    state.tab = loaders[page] && !['time', 'jogador', 'jogo'].includes(page) && !page.startsWith('lib') ? page : 'tabela';
    document.title = 'Painel do Brasileirão';
  }
  // Na página de um jogo, o jogo em destaque do topo só atrapalharia
  document.body.dataset.tab = state.tab;
  // Cores, abas e nome mudam conforme o campeonato
  document.body.dataset.comp = state.comp;
  $('#brand-nome').textContent = isCup() ? CUP_INFO[state.comp].name : 'Brasileirão';
  document.querySelectorAll('.comp-card').forEach((c) => c.classList.toggle('on', c.dataset.comp === state.comp));
  let activeTab = state.tab === 'jogador' ? 'scout' : state.tab === 'jogo' ? 'jogos' : state.tab;
  if (isCup()) {
    const c = state.comp;
    activeTab = state.tab === 'jogo' ? `${c}/jogos` : state.tab === 'lib-time' ? `${c}/${CUP_INFO[c].groups ? 'grupos' : 'chave'}` : state.tab.replace('lib-', `${c}/`);
  }
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

document.addEventListener('click', (e) => {
  const card = e.target.closest('[data-jogo]');
  if (!card || e.target.closest('a, button')) return;
  location.hash = jogoHref(card.dataset.jogo);
});

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

// ---------- Ao vivo ----------

// O servidor avisa na hora quando um placar muda; o setInterval fica só de reserva.

function connectLive() {
  if (!window.EventSource) return;
  const es = new EventSource('/api/stream');
  es.addEventListener('update', () => refresh());
}

// No celular a página "dorme" em segundo plano: ao voltar, atualiza na hora.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

applyRoute();
connectLive();
setInterval(refresh, REFRESH_MS);
