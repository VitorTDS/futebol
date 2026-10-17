// ---------- Alertas de gol ----------

const ALERT_DEFAULTS = { on: false, all: false, teams: [], sound: true, vibrate: true, notify: false, kickoff: false, reminder: false, summary: false, changes: false };
const alerts = { ...ALERT_DEFAULTS, ...store.get('alertas', {}) };
// Placar de cada jogo na última leitura, para perceber o que mudou (gol, início, fim)
const lastSeen = new Map();
let audioCtx = null;
let swRegistration = null;

const canVibrate = 'vibrate' in navigator;
// Notificação do sistema só existe em endereço seguro (https ou localhost)
const canNotify = window.isSecureContext && 'Notification' in window && 'serviceWorker' in navigator;

if (canNotify) {
  navigator.serviceWorker.register('sw.js').then(
    (reg) => {
      swRegistration = reg;
      // Reenvia a inscrição a cada visita: se o servidor reiniciou e perdeu a lista, recupera
      syncPush();
    },
    () => {},
  );
}

function saveAlerts() {
  store.set('alertas', alerts);
  $('.bell-dot').hidden = !alerts.on;
  clearTimeout(state.pushTimer);
  state.pushTimer = setTimeout(syncPush, 500);
}

// ---------- Notificação com o celular bloqueado (Web Push) ----------

// Com a inscrição ativa, quem manda a notificação é o servidor (funciona até com o
// celular bloqueado); a página só mostra o aviso na tela, para não avisar duas vezes.
const canPush = canNotify && 'PushManager' in window;
let pushOn = false;

/** Chave pública em base64url → bytes, no formato que o navegador pede */
function keyBytes(base64) {
  const b64 = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Erro ${res.status}`);
  return res.json();
}

async function syncPush() {
  if (!canPush || !swRegistration) return;
  try {
    const want = alerts.on && alerts.notify && Notification.permission === 'granted';
    let sub = await swRegistration.pushManager.getSubscription();
    if (!want) {
      if (sub) {
        await postJson('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe();
      }
      pushOn = false;
      return;
    }
    const { publicKey } = await api('/api/push/key');
    // O servidor trocou de chave (ex.: hospedagem nova): refaz a inscrição
    if (sub && store.get('pushKey', null) !== publicKey) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await swRegistration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    store.set('pushKey', publicKey);
    await postJson('/api/push/subscribe', {
      subscription: sub.toJSON(),
      prefs: { all: alerts.all, teams: alerts.teams, kickoff: alerts.kickoff, reminder: alerts.reminder, summary: alerts.summary, changes: alerts.changes },
    });
    pushOn = true;
  } catch (err) {
    console.warn('Notificação com a tela bloqueada indisponível:', err.message);
    pushOn = false;
  }
}

function follows(match) {
  return alerts.all || alerts.teams.includes(match.home.id) || alerts.teams.includes(match.away.id);
}

// O navegador só deixa tocar som depois de um toque do usuário: liga o áudio aqui
function unlockAudio() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {
    audioCtx = null;
  }
}

/** Apito de juiz: dois trinados curtos e um longo. */
function whistle(kind) {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  const blasts = kind === 'goal' ? [[0, 0.18], [0.25, 0.18], [0.5, 0.7]] : [[0, 0.5]];
  for (const [start, dur] of blasts) {
    const osc = audioCtx.createOscillator();
    const trill = audioCtx.createOscillator();
    const trillGain = audioCtx.createGain();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = 2900;
    trill.frequency.value = 38; // o "trinado" da bolinha do apito
    trillGain.gain.value = 260;
    trill.connect(trillGain).connect(osc.frequency);
    gain.gain.setValueAtTime(0.0001, t0 + start);
    gain.gain.exponentialRampToValueAtTime(0.12, t0 + start + 0.02);
    gain.gain.setValueAtTime(0.12, t0 + start + dur - 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0 + start);
    trill.start(t0 + start);
    osc.stop(t0 + start + dur);
    trill.stop(t0 + start + dur);
  }
}

function alertText(ev) {
  const { match: m } = ev;
  const score = `${m.home.shortName} ${m.homeGoals ?? 0} × ${m.awayGoals ?? 0} ${m.away.shortName}`;
  if (ev.type === 'goal') {
    const who = ev.side === 'home' ? m.home : m.away;
    return { title: `GOL do ${who.shortName}!`, body: `${score}${m.minute ? ` · ${m.minute}'` : ''}`, team: who };
  }
  if (ev.type === 'kickoff') return { title: 'Começou!', body: score, team: m.home };
  return { title: 'Fim de jogo', body: score, team: m.home };
}

function showToast(ev) {
  const { title, body, team } = alertText(ev);
  const el = document.createElement('a');
  el.href = '#/jogos';
  el.className = `toast ${ev.type}`;
  el.innerHTML = `${crestImg(team)}<div><b>${escapeHtml(title)}</b><span>${escapeHtml(body)}</span></div>`;
  el.addEventListener('click', () => el.remove());
  $('#toasts').prepend(el);
  setTimeout(() => el.classList.add('saindo'), 9000);
  setTimeout(() => el.remove(), 9600);
}

function fireAlert(ev) {
  if (ev.type !== 'goal' && !alerts.kickoff) return;
  showToast(ev);
  if (alerts.sound) whistle(ev.type);
  if (alerts.vibrate && canVibrate) navigator.vibrate(ev.type === 'goal' ? [300, 100, 300, 100, 700] : [200]);
  if (alerts.notify && canNotify && Notification.permission === 'granted' && document.hidden && swRegistration && !pushOn) {
    const { title, body, team } = alertText(ev);
    swRegistration.showNotification(title, { body, icon: team.crest, tag: `jogo-${ev.match.id}`, renotify: true, data: { url: '/#/jogos' } });
  }
}

/** Compara a leitura nova dos jogos com a anterior e avisa o que aconteceu. */
function checkAlerts(matches) {
  for (const m of matches) {
    const before = lastSeen.get(m.id);
    lastSeen.set(m.id, { status: m.status, h: m.homeGoals ?? 0, a: m.awayGoals ?? 0 });
    if (!before || !alerts.on || !follows(m)) continue;
    const h = m.homeGoals ?? 0;
    const a = m.awayGoals ?? 0;
    if (before.status === 'SCHEDULED' && m.status === 'LIVE') fireAlert({ type: 'kickoff', match: m });
    if (before.status === 'LIVE' || m.status === 'LIVE') {
      for (let g = before.h; g < h; g++) fireAlert({ type: 'goal', side: 'home', match: m });
      for (let g = before.a; g < a; g++) fireAlert({ type: 'goal', side: 'away', match: m });
    }
    if (before.status === 'LIVE' && m.status === 'FINISHED') fireAlert({ type: 'fulltime', match: m });
  }
}

function renderAlertDialog(teams) {
  $('#al-on').checked = alerts.on;
  $('#al-todos').checked = alerts.all;
  $('#al-som').checked = alerts.sound;
  $('#al-vibrar').checked = alerts.vibrate;
  $('#al-notif').checked = alerts.notify && canNotify;
  $('#al-inicio').checked = alerts.kickoff;
  $('#al-lembrete').checked = alerts.reminder;
  $('#al-resumo').checked = alerts.summary;
  $('#al-mudancas').checked = alerts.changes;
  // Esses avisos vêm do servidor: só existem com a notificação do sistema (e push) ligada
  const pushReady = canPush && alerts.notify && Notification.permission === 'granted';
  $('#al-extras').classList.toggle('desligado', !pushReady);
  for (const id of ['al-lembrete', 'al-resumo', 'al-mudancas']) $('#' + id).disabled = !pushReady;
  $('#al-opcoes').classList.toggle('desligado', !alerts.on);
  $('#al-vibrar-row').hidden = !canVibrate;
  $('#al-notif').disabled = !canNotify;
  const info = $('#al-notif-info');
  info.hidden = false;
  info.textContent = !canNotify
    ? 'Notificação do sistema não está disponível neste endereço (precisa de https). O aviso na tela, o som e a vibração funcionam.'
    : Notification.permission === 'denied'
      ? 'As notificações foram bloqueadas neste navegador. Libere nas configurações do site.'
      : canPush
        ? 'Com a notificação ligada, o gol chega mesmo com o celular bloqueado. No iPhone, primeiro adicione o painel à tela de início (Compartilhar → Adicionar à Tela de Início).'
        : 'Este navegador só mostra a notificação com o painel aberto.';
  $('#al-times').innerHTML = teams
    .map(
      (t) => `<button type="button" class="al-time ${alerts.teams.includes(t.id) ? 'on' : ''}" data-id="${t.id}" aria-pressed="${alerts.teams.includes(t.id)}">
        ${crestImg(t)}<span>${escapeHtml(t.shortName)}</span></button>`,
    )
    .join('');
  $('#al-times').classList.toggle('desligado', alerts.all);
}

async function openAlertDialog() {
  unlockAudio();
  const data = await api('/api/overview');
  const teams = data.standings.map((r) => r.team).sort((a, b) => a.shortName.localeCompare(b.shortName, 'pt-BR'));
  state.alertTeams = teams;
  renderAlertDialog(teams);
  $('#alert-dialog').showModal();
}

$('#bell').addEventListener('click', () => openAlertDialog().catch((err) => showBanner(err.message, true)));

$('#alert-dialog').addEventListener('change', async (e) => {
  const map = {
    'al-on': 'on',
    'al-todos': 'all',
    'al-som': 'sound',
    'al-vibrar': 'vibrate',
    'al-notif': 'notify',
    'al-inicio': 'kickoff',
    'al-lembrete': 'reminder',
    'al-resumo': 'summary',
    'al-mudancas': 'changes',
  };
  const key = map[e.target.id];
  if (!key) return;
  alerts[key] = e.target.checked;
  if (key === 'notify' && alerts.notify && Notification.permission === 'default') {
    alerts.notify = (await Notification.requestPermission()) === 'granted';
  }
  // Ligou e não escolheu nenhum time: começa avisando de todos
  if (key === 'on' && alerts.on && !alerts.all && !alerts.teams.length) alerts.all = true;
  unlockAudio();
  saveAlerts();
  renderAlertDialog(state.alertTeams);
});

$('#al-times').addEventListener('click', (e) => {
  const btn = e.target.closest('.al-time');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  alerts.teams = alerts.teams.includes(id) ? alerts.teams.filter((x) => x !== id) : [...alerts.teams, id];
  alerts.all = false;
  saveAlerts();
  renderAlertDialog(state.alertTeams);
});

$('#al-testar').addEventListener('click', () => {
  unlockAudio();
  const t = state.alertTeams;
  const home = t.find((x) => alerts.teams.includes(x.id)) ?? t[0];
  const away = t.find((x) => x.id !== home.id);
  // A caixa de configuração fica por cima de tudo: fecha antes para o aviso aparecer
  $('#alert-dialog').close();
  setTimeout(() => fireAlert({ type: 'goal', side: 'home', match: { id: 0, home, away, homeGoals: 1, awayGoals: 0, minute: 23 } }), 300);
});

// Clicar fora da caixa fecha
$('#alert-dialog').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});

saveAlerts();
