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
  const data = await api(compApi('/matches'));
  checkAlerts(data.matches);
  // Alertas de gol valem para todos os campeonatos
  if (alerts.on) {
    for (const url of ['/api/matches', '/api/lib/matches', '/api/cdb/matches', '/api/sula/matches', '/api/serieb/matches']) {
      if (url !== compApi('/matches')) api(url).then((other) => checkAlerts(other.matches), () => {});
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
  const tag = live
    ? `<span class="tag-vivo"><i></i>AO VIVO${m.minute ? ` · ${m.minute}'` : ''}</span>`
    : finished
      ? '<span class="tag-vivo fim">ENCERRADO</span>'
      : `<span class="tag-vivo proximo">PRÓXIMO JOGO · ${escapeHtml(kickoffText(date, { long: true }))}</span>`;
  const side = (t) => {
    const href = teamHref(t.id);
    const inner = `${crestImg(t)}<b>${escapeHtml(t.shortName)}</b>`;
    return href ? `<a class="lado" href="${href}">${inner}</a>` : `<span class="lado">${inner}</span>`;
  };
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
