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
  j.data = await api(compApi(`/jogo/${j.id}`));
  const { match: m } = j.data;
  document.title = `${m.home.shortName} x ${m.away.shortName} · ${compName()}`;
  renderMatchPage();
}

function renderMatchPage() {
  const d = state.jogo.data;
  const { match: m, espn } = d;
  const live = m.status === 'LIVE';
  const finished = m.status === 'FINISHED';
  const date = new Date(m.utcDate);
  // Hoje/amanhã/ontem pelo nome; os outros dias com a data por extenso
  const near = ['Hoje', 'Amanhã', 'Ontem'].includes(dayName(date));
  const when = near ? dayName(date) : date.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
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
    ${finished ? '' : `<div class="jh-assistir">${watchButton(d.competition ?? 'bsa', '')}</div>`}
    <div class="jh-meta">${d.competition ? `${escapeHtml(compName(d.competition))} · ${escapeHtml(d.stageLabel)}${m.group ? ` · Grupo ${escapeHtml(m.group.replace('GROUP_', ''))}` : ''}` : `Brasileirão · Rodada ${m.matchday}`}${espn?.venue ? ` · ${escapeHtml(espn.venue.name)}${espn.venue.city ? `, ${escapeHtml(espn.venue.city)}` : ''}` : ''}</div>`;

  const tabs = JOGO_TABS.filter(([k]) => k !== 'tabela' || d.standings);
  if (!tabs.some(([k]) => k === state.jogo.tab)) state.jogo.tab = 'resumo';
  $('#jogo-back').href = state.comp === 'bsa' ? '#/jogos' : `#/${state.comp}/jogos`;
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
