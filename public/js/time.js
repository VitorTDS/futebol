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

// O mesmo time nas copas que ele joga: situação, chance de título e link para a campanha
function renderTeamCups(d) {
  $('#team-cups-box').hidden = !d.cups.length;
  $('#team-cups').innerHTML = d.cups
    .map((c) => {
      const situation = c.won
        ? 'Campeão'
        : c.eliminated
          ? `Eliminado: ${c.eliminated.label.toLowerCase()}${c.eliminated.sulamericana ? ' (foi para a Sul-Americana)' : ''}`
          : c.now?.opponent
            ? `${c.now.label} contra o ${escapeHtml(c.now.opponent.shortName)}${c.now.advance != null ? ` · ${pct(c.now.advance)} de chance de passar` : ''}`
            : c.now
              ? `${c.now.label} em disputa`
              : 'Na disputa';
      return `<a class="copa-time ${c.eliminated ? 'fora' : ''}" data-copa="${c.comp}" href="${teamHref(d.team.id, c.comp)}">
        <small>${escapeHtml(c.name)}</small>
        <b>${c.eliminated ? '—' : pct(c.champion)}</b>
        <span>${c.eliminated ? situation : `de chance de título · ${situation}`}</span>
      </a>`;
    })
    .join('');
}

async function loadTeam() {
  const d = await api(`/api/teams/${state.teamId}`);
  document.title = `${d.team.shortName} · Painel do Brasileirão`;

  renderTeamHeader(d);
  renderTeamStats(d);
  renderTeamCharts(d);
  renderTeamSplit(d);
  renderTeamStreaks(d);
  renderTeamCups(d);
  // Próximos jogos de todas as competições, por data
  const upcoming = [...d.upcoming, ...d.cups.flatMap((c) => c.upcoming)].sort((x, y) => x.utcDate.localeCompare(y.utcDate));
  $('#team-upcoming').innerHTML = upcoming.length
    ? upcoming.map((m) => matchCard(m, d.watchUrl)).join('')
    : '<div class="empty">Não há mais jogos no campeonato.</div>';
  renderTeamResults(d);
  renderTeamChances(d.team.id).catch(() => {});
}

// Título, Libertadores e rebaixamento do time ao fim de cada rodada
async function renderTeamChances(teamId) {
  const data = await api('/api/chances');
  const t = data.teams.find((x) => x.team.id === teamId);
  if (!t || state.teamId !== teamId) return;
  const line = (label, values, color) => ({
    label,
    data: values.map((p) => Math.round(p * 1000) / 10),
    borderColor: color,
    backgroundColor: color,
    borderWidth: 2.5,
    tension: 0.25,
    pointRadius: 1.5,
  });
  upsertChart('teamChances', $('#team-chances-chart'), {
    type: 'line',
    data: {
      labels: data.rounds.map((r) => (r === 0 ? 'início' : r)),
      datasets: [line('Título', t.title, '#c99a06'), line('G5 (Libertadores pela tabela)', t.libertadores, ZONE_COLORS.lib), line('Rebaixamento', t.relegation, ZONE_COLORS.reb)],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: { y: { min: 0, max: 100, ticks: { callback: (v) => `${v}%` } } },
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 12 } },
        tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${String(item.raw).replace('.', ',')}%` } },
      },
    },
  });
}
