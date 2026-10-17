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

// ---------- Modelo × casas de apostas ----------

const SIDE_NAME = { H: (m) => m.home.shortName, D: () => 'o empate', A: (m) => m.away.shortName };

async function loadMercado() {
  clearTimeout(state.mercadoRetry);
  const d = await api('/api/mercado');
  const p = d.progress;
  const s = d.season;
  const loading = !p.ready ? `<p class="muted">Buscando as cotações dos jogos encerrados: ${p.loaded} de ${p.total}… (só na primeira vez)</p>` : '';
  const num = (v) => v.toFixed(3).replace('.', ',');
  $('#mercado-stats').innerHTML =
    loading +
    (s
      ? [
          statCard('Acerto do favorito', `${pct(s.model.accuracy)} × ${pct(s.market.accuracy)}`, `modelo × ${escapeHtml(s.provider)}, em ${s.matches} jogos`),
          statCard('Nota de precisão (Brier)', `${num(s.model.brier)} × ${num(s.market.brier)}`, `quanto menor, melhor · ${s.model.brier < s.market.brier ? 'o modelo foi mais preciso' : 'o mercado foi mais preciso'}`),
          statCard('Jogo a jogo', `${s.modelBetter} de ${s.matches}`, 'jogos em que o modelo chegou mais perto que o mercado'),
        ].join('')
      : '');
  $('#mercado-proximos').innerHTML = d.upcoming.length
    ? `<div class="table-wrap"><table>
      <thead><tr><th class="left">Jogo</th><th>Data</th><th>Modelo</th><th>Mercado</th><th class="left">Maior diferença</th></tr></thead>
      <tbody>${d.upcoming
        .map((r) => {
          const m = r.match;
          const trio = (x) => `${pct(x.H)} · ${pct(x.D)} · ${pct(x.A)}`;
          const who = SIDE_NAME[r.biggest.side](m);
          const pts = Math.round(Math.abs(r.biggest.diff) * 100);
          const date = kickoffText(m.utcDate);
          return `<tr class="linha-jogo" data-jogo="${m.id}">
            <td class="left"><span class="matchup">${teamHtml(m.home, { short: true })} x ${teamHtml(m.away, { short: true })}</span></td>
            <td>${date}</td><td>${trio(r.model)}</td><td>${trio(r.market)}</td>
            <td class="left">${pts < 3 ? '<span class="muted">concordam</span>' : `Modelo dá <b>${r.biggest.diff > 0 ? '+' : '−'}${pts} pontos</b> para ${escapeHtml(who)}`}</td>
          </tr>`;
        })
        .join('')}</tbody></table></div>
      <p class="muted">Chances na ordem mandante · empate · visitante.</p>`
    : '<div class="empty">Sem cotações para os próximos jogos ainda.</div>';
  // Enquanto as cotações carregam, atualiza o andamento (só com a aba aberta)
  if (!p.ready) state.mercadoRetry = setTimeout(() => state.tab === 'acertos' && loadMercado().catch(() => {}), 5000);
}

async function loadHistory() {
  loadMercado().catch((err) => ($('#mercado-stats').innerHTML = `<div class="empty">Cotações indisponíveis: ${escapeHtml(err.message)}</div>`));
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
