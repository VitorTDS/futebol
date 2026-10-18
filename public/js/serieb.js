// ---------- Série B ----------

state.b = { matchday: null, total: 38 };

async function bMeta() {
  const o = await api('/api/serieb/overview');
  const updated = new Date(o.updatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  // A linha do topo é de todas as telas: só escreve se a Série B ainda está aberta
  if (state.comp === 'serieb') $('#meta').textContent = `Série B 2026 · Rodada ${o.currentMatchday} de ${o.totalMatchdays} · fonte: ${o.source} · atualizado às ${updated}`;
  $('#serieb-fase').textContent = `Rodada ${o.currentMatchday}`;
  return o;
}

async function loadBTable() {
  const o = await bMeta();
  const total = o.standings.length;
  const zone = (pos) => (pos <= o.zones.promotion ? 'lib' : pos > total - o.zones.relegation ? 'reb' : '');
  $('#b-standings').innerHTML = o.standings
    .map(
      (r) => `<tr class="${zone(r.position)}">
        <td class="pos">${r.position}</td>
        <td class="left">${teamHtml(r.team)}</td>
        <td class="points">${r.points}</td><td>${r.played}</td><td>${r.won}</td>
        <td>${r.goalDiff > 0 ? '+' : ''}${r.goalDiff}</td>
        <td><span class="form">${r.form.map((x, i) => formLink(x, r.formMatches[i])).join('')}</span></td>
        ${probCell(r.outlook.title, 'var(--titulo)')}${probCell(r.outlook.promotion, 'var(--lib)')}${probCell(r.outlook.relegation, 'var(--reb)')}
      </tr>`,
    )
    .join('');
  // Corrida: quem ainda pode subir ou cair
  const race = (key, color) =>
    o.standings
      .filter((r) => r.outlook[key] > 0 && r.outlook[key] < 1)
      .sort((a, b) => b.outlook[key] - a.outlook[key])
      .slice(0, 8)
      .map(
        (r) => `<div class="linha">${crestImg(r.team)}
          <div class="trilho" style="--c:${color}"><div data-w="${r.outlook[key]}"></div><span>${escapeHtml(r.team.shortName)}</span></div>
          <b>${pct(r.outlook[key])}</b></div>`,
      )
      .join('') || '<div class="empty">Já está decidido.</div>';
  $('#b-corrida-acesso').innerHTML = race('promotion', 'var(--lib)');
  $('#b-corrida-queda').innerHTML = race('relegation', 'var(--reb)');
  $('#b-nota').textContent = `Chances calculadas com ${o.simulations.toLocaleString('pt-BR')} simulações do resto da Série B. Os 4 primeiros sobem para a Série A e os 4 últimos caem para a Série C.`;
  growBars($('#b-tabela'));
}

async function loadBMatches() {
  const b = state.b;
  const data = await api(`/api/serieb/matches${b.matchday ? `?matchday=${b.matchday}` : ''}`);
  bMeta().catch(() => {});
  b.matchday = data.matchday;
  b.total = data.totalMatchdays;
  $('#b-round').textContent = `Rodada ${data.matchday}`;
  $('#b-prev').disabled = data.matchday <= 1;
  $('#b-next').disabled = data.matchday >= data.totalMatchdays;
  $('#b-matches').innerHTML = data.matches.map((m) => matchCard(m, data.watchUrl)).join('') || '<div class="empty">Sem jogos nesta rodada.</div>';
  growBars($('#b-matches'));
}

$('#b-prev').addEventListener('click', () => {
  state.b.matchday = Math.max(1, state.b.matchday - 1);
  refresh();
});
$('#b-next').addEventListener('click', () => {
  state.b.matchday = Math.min(state.b.total, state.b.matchday + 1);
  refresh();
});

// ---------- Página do time na Série B ----------

async function loadBTeam() {
  const d = await api(`/api/serieb/time/${state.b.teamId}`);
  const t = d.team;
  const s = d.standing;
  const o = d.outlook;
  document.title = `${t.shortName} · Série B`;
  const icon = t.crest ? `<img class="crest big" src="${escapeHtml(t.crest)}" alt="" />` : `<span class="badge big">${escapeHtml(t.tla)}</span>`;
  $('#b-team-header').innerHTML = `${icon}<div><h2>${escapeHtml(t.name)}</h2>
    <p class="muted">${s.position}º lugar na Série B · ${s.points} pontos em ${s.played} jogos</p></div>`;
  const r = d.ratings;
  $('#b-team-stats').innerHTML = [
    statCard('Pontos projetados', o.expectedPoints.toFixed(1).replace('.', ','), `hoje tem ${s.points} · previsão para o fim da Série B`),
    statCard('Chances', `<span class="chance-line"><small>Acesso</small> ${pct(o.promotion)}</span>`, `Título ${pct(o.title)} · Queda ${pct(o.relegation)}`),
    statCard('Ataque', `${r.attackRank}º`, `da Série B · ${ratingText(r.attack, 'attack').replace('da liga', 'da Série B')}`),
    statCard('Defesa', `${r.defenseRank}º`, `da Série B · ${ratingText(r.defense, 'defense').replace('da liga', 'da Série B')}`),
  ].join('');
  renderTeamCups(d, '#b-team-cups-box', '#b-team-cups');

  const total = d.totalTeams;
  const zoneColor = (pos) => (pos <= d.zones.promotion ? ZONE_COLORS.lib : pos > total - d.zones.relegation ? ZONE_COLORS.reb : ZONE_COLORS.mid);
  upsertChart('bTeamPos', $('#b-team-pos-chart'), {
    type: 'line',
    data: {
      labels: d.evolution.matchdays,
      datasets: [{ data: d.evolution.positions, borderColor: '#1f7a4d', backgroundColor: '#1f7a4d', tension: 0.25, pointRadius: 2 }],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { reverse: true, min: 1, max: total, ticks: { stepSize: 4 } } },
    },
  });
  upsertChart('bTeamFinal', $('#b-team-final-chart'), {
    type: 'bar',
    data: {
      labels: o.positionProbs.map((_, i) => `${i + 1}º`),
      datasets: [{ data: o.positionProbs.map((p) => Math.round(p * 1000) / 10), backgroundColor: o.positionProbs.map((_, i) => zoneColor(i + 1)) }],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (item) => `${String(item.raw).replace('.', ',')}%` } } },
      scales: { y: { ticks: { callback: (v) => `${v}%` } } },
    },
  });

  // Próximos jogos da Série B e das copas, por data
  const upcoming = [...d.upcoming, ...d.cups.flatMap((c) => c.upcoming)].sort((x, y) => x.utcDate.localeCompare(y.utcDate));
  $('#b-team-upcoming').innerHTML = upcoming.length
    ? upcoming.map((m) => matchCard(m, d.watchUrl)).join('')
    : '<div class="empty">Não há mais jogos.</div>';
  renderTeamResults(d, '#b-team-results');
  growBars($('#b-time'));
}
