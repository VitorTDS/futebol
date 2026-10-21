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
      ? '<div class="banner">Jogadores de exemplo (números sorteados). Para os dados reais, crie uma conta na <a href="https://dashboard.api-football.com/register" target="_blank" rel="noopener">API-Football</a> e coloque a chave em <code>APIFOOTBALL_KEY</code> (no arquivo <code>.env</code> ou nas variáveis da hospedagem). Confira no painel deles se o seu plano libera a temporada atual: o plano grátis costuma liberar só temporadas antigas.</div>'
      : '';
  return true;
}

function percentileChip(p) {
  if (p == null) return '';
  const tier = p >= 80 ? 'top' : p >= 50 ? 'mid' : 'low';
  return `<span class="pchip ${tier}" title="Percentil ${Math.round(p)}">${Math.round(p)}</span>`;
}

const SCOUT_PAGE = 20;

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

  // Começa com 20 linhas (a lista inteira fica longa demais no celular); "Mostrar mais" abre de 20 em 20
  const shown = Math.min(s.shown ?? SCOUT_PAGE, data.players.length);
  $('#scout-count').textContent =
    data.total > shown ? `Mostrando ${shown} de ${data.total} jogadores` : `${data.total} jogadores`;
  $('#scout-mais').hidden = shown >= data.players.length;

  $('#scout-body').innerHTML = data.players.length
    ? data.players
        .map(
          (p, i) => `<tr${i >= shown ? ' hidden' : ''}>
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
$('#scout-mais').addEventListener('click', () => {
  state.scout.shown = (state.scout.shown ?? SCOUT_PAGE) + SCOUT_PAGE;
  refresh();
});
// Filtro novo: volta para as primeiras 20 linhas
$('#scout .filters').addEventListener('input', () => (state.scout.shown = SCOUT_PAGE));
$('#scout .filters').addEventListener('change', () => (state.scout.shown = SCOUT_PAGE));

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
// refresh vem de navegacao.js (carregado depois): chama só na hora do evento
['#scout-team', '#scout-minutes'].forEach((sel) => $(sel).addEventListener('change', () => refresh()));
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
