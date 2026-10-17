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
  if (s?.sulamericana) parts.push('quem ganha a <a href="#/sula/chave">Sul-Americana</a>');
  if (!parts.length) return '';
  // "de A, de B e de C"
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', de ')} e de ${parts.at(-1)}` : parts[0];
  return `As chances de ${list} são as mesmas das abas de cada copa.`;
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
