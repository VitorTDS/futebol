// ---------- Simulador "e se" ----------


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
  await Promise.all([recalcWhatif(), loadWhatifCups()]);
}

// Confrontos em aberto das copas que dão vaga: quem passar muda as vagas do Brasileirão
async function loadWhatifCups() {
  const lists = await Promise.all(
    Object.keys(CUP_INFO).map((comp) =>
      api(`/api/${comp}/overview`).then(
        (o) => o.stages.flatMap((s) => s.ties.filter((t) => !t.winner && t.teams[0] && t.teams[1]).map((t) => ({ ...t, comp, stage: s.label }))),
        () => [],
      ),
    ),
  );
  state.ese.cupTies = lists.flat();
  renderWhatifCups();
}

function renderWhatifCups() {
  const ties = state.ese.cupTies ?? [];
  $('#ese-copas-box').hidden = !ties.length;
  $('#ese-copas').innerHTML = ties
    .map((t) => {
      const pick = state.cupPicks[t.comp]?.[t.id];
      const btn = (team, chance) =>
        `<button data-comp="${t.comp}" data-tie="${t.id}" data-team="${team.id}" class="${pick === team.id ? 'on' : ''}" aria-pressed="${pick === team.id}">${crestImg(team)}${escapeHtml(team.shortName)}${chance != null ? `<small>${pct(chance)}</small>` : ''}</button>`;
      return `<div class="ese-jogo ${pick ? 'escolhido' : ''}">
        <span class="ese-copa-nome">${escapeHtml(CUP_INFO[t.comp].name)} · ${escapeHtml(t.stage)}</span>
        <div class="seg2">${btn(t.teams[0], t.advance)}${btn(t.teams[1], t.advance != null ? 1 - t.advance : null)}</div>
      </div>`;
    })
    .join('');
}

$('#ese-copas').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tie]');
  if (!b) return;
  const picks = (state.cupPicks[b.dataset.comp] ??= {});
  const team = Number(b.dataset.team);
  if (picks[b.dataset.tie] === team) delete picks[b.dataset.tie];
  else picks[b.dataset.tie] = team;
  saveCupPicks();
  renderWhatifCups();
  renderWhatifMatches();
  scheduleWhatif();
});

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

  const n = Object.keys(ese.picks).length + Object.keys(CUP_INFO).reduce((s, c) => s + Object.keys(state.cupPicks[c] ?? {}).length, 0);
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
    body: JSON.stringify({ picks: ese.picks, cupPicks: state.cupPicks }),
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
  state.cupPicks = { lib: {}, cdb: {}, sula: {} };
  saveCupPicks();
  renderWhatifCups();
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
