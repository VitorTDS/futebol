// ---------- Jogo em destaque no topo ----------

// Ao vivo primeiro; senão o próximo a começar; senão o último encerrado.
function pickHighlight(matches) {
  const live = matches.filter((m) => m.status === 'LIVE');
  if (live.length) return live[0];
  const next = matches.filter((m) => m.status === 'SCHEDULED').sort((a, b) => a.utcDate.localeCompare(b.utcDate));
  if (next.length) return next[0];
  return [...matches].sort((a, b) => b.utcDate.localeCompare(a.utcDate))[0];
}

// ---------- Jogo escolhido para o topo ----------
// Guardado por campeonato: { id, q } (q = a lista onde o jogo está: rodada ou fase).
// Vale até o jogo acabar há mais de 3 horas; depois o topo volta a escolher sozinho.

const pinKey = (comp) => `destaque.${comp}`;
const getPin = (comp = state.comp) => store.get(pinKey(comp), null);

/** Lista em que o jogo está, para o topo buscar de novo: rodada (ligas) ou fase (copas) */
const matchListQuery = (m, comp) => (comp in CUP_INFO ? `?stage=${encodeURIComponent(m.stage)}` : `?matchday=${m.matchday}`);

function pinMatch(m, comp = m.comp ?? state.comp) {
  store.set(pinKey(comp), { id: m.id, q: matchListQuery(m, comp) });
  state.heroHtml = null;
}

function unpinMatch(comp = state.comp) {
  store.set(pinKey(comp), null);
  state.heroHtml = null;
}

async function loadHero() {
  const data = await api(compApi('/matches'));
  checkAlerts(data.matches);
  // Jogo escolhido pela pessoa (pode ser de outra rodada ou fase)
  const pin = getPin();
  let list = data.matches;
  let pinned = null;
  if (pin) {
    const other = pin.q ? await api(compApi(`/matches${pin.q}`)).catch(() => null) : null;
    list = other?.matches ?? data.matches;
    pinned = list.find((x) => x.id === pin.id) ?? null;
    const over = pinned && pinned.status === 'FINISHED' && Date.now() - Date.parse(pinned.utcDate) > 5 * 3_600_000;
    if (!pinned || over) {
      unpinMatch();
      list = data.matches;
      pinned = null;
    }
  }
  state.heroList = list;
  // Alertas de gol valem para todos os campeonatos
  if (alerts.on) {
    for (const url of ['/api/matches', '/api/lib/matches', '/api/cdb/matches', '/api/sula/matches', '/api/serieb/matches']) {
      if (url !== compApi('/matches')) api(url).then((other) => checkAlerts(other.matches), () => {});
    }
  }
  const m = pinned ?? pickHighlight(list);
  state.heroMatch = m;
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
    ${pinned ? `<div class="destaque-escolhido">📌 Escolhido por você · <button class="link-btn" data-hero="auto">↺ automático</button></div>` : ''}
    <div class="destaque-escolha">
      <button class="seta" data-hero="-1" aria-label="Jogo anterior" title="Jogo anterior">‹</button>
      <div class="destaque-links">${finished ? '' : watchButton(state.comp, '', 'watch')}<a class="ver-detalhes" href="${jogoHref(m.id)}">Ver detalhes <span class="hide-sm">do jogo </span>›</a></div>
      <button class="seta" data-hero="1" aria-label="Próximo jogo" title="Próximo jogo">›</button>
    </div>`;
  // Só redesenha se algo mudou, para as barras não recomeçarem a cada atualização.
  if (state.heroHtml === html) return;
  state.heroHtml = html;
  $('#destaque').innerHTML = html;
  growBars($('#destaque'));
}

// Setas do topo: passa pelos jogos da mesma rodada (ou fase), na ordem do horário
$('#destaque').addEventListener('click', (e) => {
  const b = e.target.closest('[data-hero]');
  if (!b) return;
  if (b.dataset.hero === 'auto') unpinMatch();
  else {
    const list = [...(state.heroList ?? [])].sort((x, y) => x.utcDate.localeCompare(y.utcDate));
    const i = list.findIndex((x) => x.id === state.heroMatch?.id);
    const next = list[(i + Number(b.dataset.hero) + list.length) % list.length];
    if (next) pinMatch(next, state.comp);
  }
  loadHero().catch(() => {});
});

// Botão "Destacar no topo" dos cards de jogo e da página do jogo
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pin]');
  if (!b) return;
  e.preventDefault();
  const comp = b.dataset.comp || state.comp;
  store.set(pinKey(comp), { id: Number(b.dataset.pin), q: b.dataset.q });
  state.heroHtml = null;
  b.textContent = '📌 No topo';
  // Leva a pessoa para o topo, onde o jogo aparece
  if (comp === state.comp) loadHero().then(() => window.scrollTo({ top: 0, behavior: 'smooth' }), () => {});
});
