// ---------- Navegação ----------

const CHART_TABS = new Set(['evolucao', 'acertos', 'time', 'scout', 'jogador', 'b-time']);

const loaders = {
  tabela: loadOverview,
  jogos: loadMatches,
  evolucao: loadEvolution,
  acertos: loadHistory,
  artilharia: loadScorers,
  time: loadTeam,
  scout: loadScout,
  jogador: loadPlayer,
  jogo: loadMatchPage,
  'lib-chave': loadLibBracket,
  'lib-jogos': loadLibMatches,
  'lib-grupos': loadLibGroups,
  'lib-gols': loadLibScorers,
  'lib-time': loadLibTeam,
  agenda: loadAgenda,
  'b-tabela': loadBTable,
  'b-jogos': loadBMatches,
  'b-time': loadBTeam,
  ese: loadWhatif,
};

// Fonte fora do ar: o servidor segue com os últimos placares, e a página diz de quando são
async function checkSource() {
  const s = (await api('/api/status'))[state.comp];
  const el = $('#fonte-aviso');
  el.hidden = !s || s.ok;
  if (el.hidden) return;
  const hora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  el.textContent = s.lastOk
    ? `⚠ A fonte dos dados está fora do ar desde ${hora(s.failingSince)}. Mostrando os placares de ${hora(s.lastOk)}.`
    : '⚠ A fonte dos dados está fora do ar.';
}

// Cada carga de tela ganha um número: se a pessoa já foi para outra tela quando
// esta termina (internet lenta), o resultado dela não vale mais
state.refreshSeq = 0;

async function refresh() {
  const seq = ++state.refreshSeq;
  checkSource().catch(() => {});
  try {
    const hero = loadHero();
    if (state.comp === 'bsa' && !state.metaSet && state.tab !== 'tabela') api('/api/overview').then(setMeta, () => {});
    if (isCup() && state.tab === 'jogo') libMeta().catch(() => {});
    if (state.comp === 'serieb' && ['jogo', 'b-time', 'ese'].includes(state.tab)) bMeta().catch(() => {});
    // Telas com gráfico: baixa a biblioteca antes (só na primeira vez)
    if (CHART_TABS.has(state.tab)) await ensureChart();
    await loaders[state.tab]();
    await hero;
    // Deu certo: some o aviso de erro que tenha sobrado de uma carga anterior
    if (seq === state.refreshSeq && $('#banner').classList.contains('error')) showBanner('');
  } catch (err) {
    // Carga de uma tela que a pessoa já deixou: o erro dela não interessa mais
    if (seq !== state.refreshSeq) return;
    // No console fica o erro completo (com a linha), para investigar
    console.error(err);
    showBanner(`Não foi possível carregar os dados: ${err.message}`, true);
  }
}

// Navegação pelo endereço: #/jogos, #/time/12 etc. (o botão "voltar" do navegador funciona)
function applyRoute() {
  const [page, id, , vsId] = location.hash.replace(/^#\/?/, '').split('/');
  // A agenda é de todos os campeonatos: fica com as cores do que estava aberto
  const comp = page in CUP_INFO || page === 'serieb' ? page : page === 'agenda' ? state.comp : 'bsa';
  if (comp !== state.comp) {
    state.comp = comp;
    state.lib.stage = null;
    state.metaSet = false;
    state.heroHtml = null;
    state.jogo.data = null;
    $('#meta').textContent = 'Carregando…';
  }
  if (page === 'agenda') {
    state.tab = 'agenda';
    document.title = 'Agenda · Painel';
  } else if (comp === 'serieb') {
    // #/serieb/tabela, #/serieb/jogos, #/serieb/jogo/123
    const jogoId = Number(location.hash.split('/')[3]);
    if (id === 'jogo' && jogoId) {
      state.tab = 'jogo';
      if (state.jogo.id !== jogoId) {
        state.jogo.tab = 'resumo';
        window.scrollTo(0, 0);
      }
      state.jogo.id = jogoId;
    } else if (id === 'time' && jogoId) {
      state.tab = 'b-time';
      if (state.b.teamId !== jogoId) window.scrollTo(0, 0);
      state.b.teamId = jogoId;
    } else {
      state.tab = id === 'jogos' ? 'b-jogos' : id === 'ese' ? 'ese' : 'b-tabela';
      document.title = 'Série B · Painel';
    }
  } else if (isCup()) {
    // #/lib/chave, #/cdb/jogos, #/lib/jogo/123, #/cdb/time/45...
    const jogoId = Number(location.hash.split('/')[3]);
    if (id === 'time' && jogoId) {
      state.tab = 'lib-time';
      if (state.lib.teamId !== jogoId) window.scrollTo(0, 0);
      state.lib.teamId = jogoId;
    } else if (id === 'jogo' && jogoId) {
      state.tab = 'jogo';
      if (state.jogo.id !== jogoId) {
        state.jogo.tab = 'resumo';
        window.scrollTo(0, 0);
      }
      state.jogo.id = jogoId;
    } else {
      const pages = CUP_INFO[comp].pages;
      state.tab = `lib-${pages.includes(id) ? id : 'chave'}`;
      document.title = `${CUP_INFO[comp].name} · Painel`;
    }
  } else if (page === 'time' && Number(id)) {
    state.tab = 'time';
    state.teamId = Number(id);
    window.scrollTo(0, 0);
  } else if (page === 'jogo' && Number(id)) {
    state.tab = 'jogo';
    if (state.jogo.id !== Number(id)) {
      state.jogo.tab = 'resumo';
      window.scrollTo(0, 0);
    }
    state.jogo.id = Number(id);
  } else if (page === 'jogador' && Number(id)) {
    // #/jogador/12 ou #/jogador/12/vs/34
    state.tab = 'jogador';
    if (state.playerId !== Number(id)) window.scrollTo(0, 0);
    state.playerId = Number(id);
    state.compareId = Number(vsId) || null;
  } else {
    state.tab = loaders[page] && !['time', 'jogador', 'jogo'].includes(page) && !page.startsWith('lib') ? page : 'tabela';
    document.title = 'Painel do Brasileirão';
  }
  // Na página de um jogo, o jogo em destaque do topo só atrapalharia
  document.body.dataset.tab = state.tab;
  // Cores, abas e nome mudam conforme o campeonato
  document.body.dataset.comp = state.comp;
  $('#brand-nome').textContent = compName();
  document.querySelectorAll('.comp-card').forEach((c) => c.classList.toggle('on', c.dataset.comp === state.comp));
  let activeTab = state.tab === 'jogador' ? 'scout' : state.tab === 'jogo' ? 'jogos' : state.tab;
  if (state.comp === 'serieb') activeTab = state.tab === 'jogo' ? 'serieb/jogos' : state.tab === 'ese' ? 'serieb/ese' : state.tab === 'b-time' ? 'serieb/tabela' : state.tab.replace('b-', 'serieb/');
  if (isCup()) {
    const c = state.comp;
    activeTab = state.tab === 'jogo' ? `${c}/jogos` : state.tab === 'lib-time' ? `${c}/${CUP_INFO[c].pages.includes('grupos') ? 'grupos' : 'chave'}` : state.tab.replace('lib-', `${c}/`);
  }
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === state.tab));
  refresh();
}

document.querySelectorAll('.tab').forEach((btn) =>
  btn.addEventListener('click', () => {
    location.hash = `#/${btn.dataset.tab}`;
  }),
);
window.addEventListener('hashchange', applyRoute);

document.addEventListener('click', (e) => {
  const card = e.target.closest('[data-jogo]');
  if (!card || e.target.closest('a, button')) return;
  location.hash = jogoHref(card.dataset.jogo, card.dataset.comp);
});

$('#prev-round').addEventListener('click', () => {
  state.matchday = Math.max(1, state.matchday - 1);
  refresh();
});
$('#next-round').addEventListener('click', () => {
  state.matchday = Math.min(state.totalMatchdays, state.matchday + 1);
  refresh();
});

$('#history-prev').addEventListener('click', () => {
  state.history.matchday = Math.max(state.history.first, state.history.matchday - 1);
  refresh();
});
$('#history-next').addEventListener('click', () => {
  state.history.matchday = Math.min(state.history.last, state.history.matchday + 1);
  refresh();
});
