// ---------- Série B ----------

state.b = { matchday: null, total: 38 };

async function bMeta() {
  const o = await api('/api/serieb/overview');
  const updated = new Date(o.updatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  $('#meta').textContent = `Série B 2026 · Rodada ${o.currentMatchday} de ${o.totalMatchdays} · fonte: ${o.source} · atualizado às ${updated}`;
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
