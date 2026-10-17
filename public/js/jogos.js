// ---------- Jogos ----------

// `showComp`: mostra sempre o campeonato (na agenda, que mistura todos)
function matchCard(m, watchUrl, { showComp = false } = {}) {
  const date = new Date(m.utcDate);
  const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const live = m.status === 'LIVE';
  const finished = m.status === 'FINISHED';

  const status = live
    ? `<span class="live-tag">● AO VIVO${m.minute ? ` ${m.minute}'` : ''}</span>`
    : finished
      ? 'Encerrado'
      : kickoffText(date);

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

  // Jogo de outro campeonato (ex.: copa na página do time): diz qual e aponta para lá
  const comp = m.comp && (showComp || m.comp !== state.comp) ? m.comp : undefined;
  const compLabel = comp ? `<span class="comp-tag">${escapeHtml(compName(comp))}${m.stageLabel ? ` · ${escapeHtml(m.stageLabel)}` : ''}</span>` : '';
  return `<article class="match ${live ? 'live' : ''}" data-jogo="${m.id}"${comp ? ` data-comp="${comp}"` : ''}>
    <div class="match-head"><span>${status}</span>${compLabel}</div>
    <div class="scoreline">${teamHtml(m.home, { comp })}${score}${teamHtml(m.away, { comp })}</div>
    ${prediction}
    <a class="ver-jogo" href="${jogoHref(m.id, comp)}">Ver detalhes do jogo ›</a>
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
