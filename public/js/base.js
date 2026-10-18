// Os arquivos de public/js são juntados pelo servidor num só (/app.js), na ordem de
// PAGE_SCRIPTS em src/server.ts: dividem o mesmo escopo global (o que um declara,
// os seguintes enxergam).

const REFRESH_MS = 60_000;

const state = {
  tab: 'tabela',
  matchday: null,
  totalMatchdays: 38,
  evolutionChart: null,
  history: { matchday: null, first: 1, last: 1, accuracyChart: null, calibrationChart: null },
};

// Cores dos gráficos seguem o tema (claro ou escuro)
function chartColors() {
  if (!window.Chart) return;
  const css = getComputedStyle(document.documentElement);
  Chart.defaults.color = css.getPropertyValue('--muted').trim() || '#6b6a5c';
  Chart.defaults.borderColor = css.getPropertyValue('--border').trim() || '#e2dccb';
}

// A biblioteca de gráficos (60 KB) só é baixada quando uma tela com gráfico abre
const CHART_URL = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
let chartLoading = null;
function ensureChart() {
  if (window.Chart) return Promise.resolve();
  chartLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = CHART_URL;
    s.onload = () => {
      Chart.defaults.font.family = 'Archivo, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      chartColors();
      resolve();
    };
    s.onerror = () => {
      chartLoading = null;
      reject(new Error('não foi possível carregar os gráficos'));
    };
    document.head.append(s);
  });
  return chartLoading;
}

const $ = (sel) => document.querySelector(sel);

// Campeonato aberto: Brasileirão (bsa) ou uma copa: Libertadores (lib), Copa do Brasil (cdb), Sul-Americana (sula)
state.comp = 'bsa';
const CUP_INFO = {
  lib: {
    name: 'Libertadores',
    title: 'CONMEBOL Libertadores 2026',
    slogan: 'a glória eterna',
    pages: ['chave', 'jogos', 'grupos', 'gols'],
    model: 'da Libertadores',
    legend: { lib: 'Oitavas de final', sul: 'Sul-Americana' },
  },
  cdb: {
    name: 'Copa do Brasil',
    title: 'Copa do Brasil 2026',
    slogan: 'vaga direta na Libertadores',
    pages: ['chave', 'jogos', 'gols'],
    model: 'da Copa do Brasil e do Brasileirão',
    scorersNote: 'Gols contados a partir da quarta fase: a ESPN não tem a lista de quem marcou nas três primeiras fases.',
  },
  sula: {
    name: 'Sul-Americana',
    title: 'CONMEBOL Sul-Americana 2026',
    slogan: 'o campeão vai à Libertadores',
    pages: ['chave', 'jogos', 'grupos', 'gols'],
    model: 'da Sul-Americana, do Brasileirão e da Libertadores',
    legend: { lib: 'Mata-mata (1º direto às oitavas, 2º nos playoffs)', sul: null },
  },
};
const isCup = () => state.comp in CUP_INFO;
// "E se" nas copas: quem passa em cada confronto ({ lib: { 'SEMI_FINALS:0': id } }).
// Vale no chaveamento de cada copa e nas vagas do "e se" do Brasileirão.
const saveCupPicks = () => store.set('copas.picks', state.cupPicks);
const hasPicks = (comp) => Object.keys(state.cupPicks[comp] ?? {}).length > 0;
const cupApi = (p) => `/api/${state.comp}${p}`;
// Nome e endereço da API de qualquer campeonato (o Brasileirão fica direto em /api)
const COMP_NAMES = { bsa: 'Brasileirão', serieb: 'Série B' };
const compName = (comp = state.comp) => CUP_INFO[comp]?.name ?? COMP_NAMES[comp] ?? 'Brasileirão';
const compApi = (p, comp = state.comp) => (comp === 'bsa' ? `/api${p}` : `/api/${comp}${p}`);
// Na Libertadores, todo clube (brasileiro ou não) tem a sua página
// `comp` muda o campeonato do link (ex.: jogo de copa na página do time no Brasileirão)
const teamHref = (id, comp = state.comp) => (comp === 'bsa' ? `#/time/${id}` : `#/${comp}/time/${id}`);
const jogoHref = (id, comp = state.comp) => (comp === 'bsa' ? `#/jogo/${id}` : `#/${comp}/jogo/${id}`);

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path) {
  const res = await fetch(path);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Erro ${res.status}`);
  // Sem internet: o service worker devolveu a cópia guardada (e diz de quando é)
  showOffline(res.headers.get('x-painel-offline'));
  return body;
}

/** Aviso "sem internet": some sozinho quando uma resposta volta a vir da rede */
function showOffline(savedAt) {
  const el = $('#offline-aviso');
  if (!savedAt) {
    if (navigator.onLine) el.hidden = true;
    return;
  }
  const when = new Date(savedAt);
  const hora = Number.isNaN(when.getTime()) ? '' : ` de ${dayName(when).toLowerCase()} às ${when.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  el.textContent = `📵 Sem internet: mostrando os dados guardados${hora}.`;
  el.hidden = false;
}

window.addEventListener('offline', () => {
  $('#offline-aviso').textContent = '📵 Sem internet: mostrando os dados guardados.';
  $('#offline-aviso').hidden = false;
});
window.addEventListener('online', () => {
  $('#offline-aviso').hidden = true;
  refresh();
});

/**
 * Dia do jogo pelo relógio do aparelho: "Hoje", "Amanhã", "Ontem" ou o dia da
 * semana com a data. É calculado na hora de desenhar, então o jogo de "amanhã"
 * vira "hoje" sozinho quando o dia vira (a página se redesenha à meia-noite).
 */
function dayName(date, { long = false } = {}) {
  const d = new Date(date);
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  // round: dia com horário de verão tem 23 ou 25 horas
  const diff = Math.round((startOfDay(d) - startOfDay(new Date())) / 86_400_000);
  if (diff === 0) return 'Hoje';
  if (diff === 1) return 'Amanhã';
  if (diff === -1) return 'Ontem';
  return d.toLocaleDateString('pt-BR', long ? { weekday: 'long', day: '2-digit', month: '2-digit' } : { weekday: 'short', day: '2-digit', month: '2-digit' });
}

/** "Hoje · 18:00", "Amanhã · 12:00", "qua., 21/10 · 21:30" */
const kickoffText = (date, opts) => `${dayName(date, opts)} · ${new Date(date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;

// Link do botão "Assistir" de cada campeonato (vem do servidor; .env pode trocar)
state.watch = {};
api('/api/assistir').then((w) => (state.watch = w), () => {});

/** Botão "Assistir" do jogo: abre o canal do campeonato (no celular, o app do Globoplay) */
function watchButton(comp, fallbackUrl, cls = 'watch') {
  const w = state.watch[comp] ?? { url: fallbackUrl, label: null };
  if (!w.url) return '';
  return `<a class="${cls}" href="${escapeHtml(w.url)}" target="_blank" rel="noopener">📺 Assistir${w.label ? ` no ${escapeHtml(w.label)}` : ''}</a>`;
}

function pct(p) {
  if (p == null) return '–';
  if (p === 0) return '–';
  if (p < 0.001) return '<0,1%';
  if (p > 0.999 && p < 1) return '>99,9%';
  return (p * 100).toLocaleString('pt-BR', { maximumFractionDigits: p < 0.1 ? 1 : 0 }) + '%';
}

function teamHtml(team, { short = false, comp } = {}) {
  const icon = team.crest
    ? `<img class="crest" src="${escapeHtml(team.crest)}" alt="" loading="lazy" />`
    : `<span class="badge">${escapeHtml(team.tla)}</span>`;
  const name = `${icon}<span>${escapeHtml(short ? team.tla : team.shortName)}</span>`;
  const href = teamHref(team.id, comp);
  if (team.tbd || !href) return `<span class="team">${name}</span>`;
  return `<a class="team" href="${href}">${name}</a>`;
}

function probCell(p, color) {
  return `<td class="prob"><span class="prob-cell"><span class="mini"><div data-w="${p}" style="background:${color}"></div></span><small>${pct(p)}</small></span></td>`;
}

// Barras com data-w (0 a 1) crescem até a largura certa no próximo quadro.
function growBars(root = document) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      root.querySelectorAll('[data-w]').forEach((el) => (el.style.width = `${Math.max(0, +el.dataset.w) * 100}%`)),
    ),
  );
}

// Anima um número de 0 até o valor final.
function countUp(el, target, ms = 900) {
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    el.textContent = Math.round(target * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function probBar(p, cls = '') {
  return `<div class="probbar ${cls}" title="Vitória mandante / empate / vitória visitante">
    <div class="h" data-w="${p.pHome}"></div><div class="d" data-w="${p.pDraw}"></div><div class="a" data-w="${p.pAway}"></div>
  </div>`;
}

function crestImg(team) {
  return team.crest
    ? `<img src="${escapeHtml(team.crest)}" alt="" loading="lazy" />`
    : `<span class="badge">${escapeHtml(team.tla)}</span>`;
}

function showBanner(text, isError = false) {
  const el = $('#banner');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('error', isError);
}

// Preferências do aparelho (palpites, time do coração): podem não existir em aba anônima.
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // sem armazenamento: vale só enquanto a página estiver aberta
    }
  },
};

state.cupPicks = { lib: {}, cdb: {}, sula: {}, ...store.get('copas.picks', {}) };

// ---------- Tema: automático (segue o celular), claro ou escuro ----------

const THEMES = ['auto', 'light', 'dark'];
const THEME_TEXT = { auto: 'automático (segue o celular)', light: 'claro', dark: 'escuro' };
// Ícone: meia lua (automático), sol (claro), lua (escuro)
const THEME_ICON = {
  auto: 'M12 3a9 9 0 1 0 0 18V3z',
  light: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
  dark: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
};

/** `redraw`: redesenha a tela (não na abertura: o resto do código ainda está carregando) */
function applyTheme(theme, { redraw = true } = {}) {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  $('#tema-ico').setAttribute('d', THEME_ICON[theme]);
  $('#tema').title = `Tema: ${THEME_TEXT[theme]}`;
  $('#tema').setAttribute('aria-label', `Tema: ${THEME_TEXT[theme]}`);
  // Gráficos já desenhados ganham as cores novas
  chartColors();
  for (const chart of Object.values(window.Chart?.instances ?? {})) {
    for (const axis of Object.values(chart.options.scales ?? {})) {
      axis.ticks && (axis.ticks.color = Chart.defaults.color);
      axis.grid && (axis.grid.color = Chart.defaults.borderColor);
      axis.title && (axis.title.color = Chart.defaults.color);
    }
    if (chart.options.plugins?.legend?.labels) chart.options.plugins.legend.labels.color = Chart.defaults.color;
    chart.update('none');
  }
  // Redesenha a tela (cores dos clubes nos gráficos mudam com o tema)
  if (redraw) refresh();
}

applyTheme(store.get('tema', 'auto'), { redraw: false });
$('#tema').addEventListener('click', () => {
  const next = THEMES[(THEMES.indexOf(store.get('tema', 'auto')) + 1) % THEMES.length];
  store.set('tema', next);
  applyTheme(next);
});
// No automático, acompanha a troca do celular (ex.: modo escuro à noite)
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => store.get('tema', 'auto') === 'auto' && applyTheme('auto'));
