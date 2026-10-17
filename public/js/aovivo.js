// ---------- Ao vivo ----------

// O servidor avisa na hora quando um placar muda; o setInterval fica só de reserva.

/** Alerta de gol de outro campeonato, sem recarregar a tela aberta */
function checkOtherComp(comp) {
  api(comp === 'bsa' ? '/api/matches' : `/api/${comp}/matches`).then((d) => checkAlerts(d.matches), () => {});
}

function connectLive() {
  if (!window.EventSource) return;
  const es = new EventSource('/api/stream');
  // O servidor acompanha os quatro campeonatos: atualiza a tela quando muda o que
  // está aberto, e os outros só importam para os alertas de gol
  es.addEventListener('update', (e) => {
    let comp = null;
    try {
      comp = JSON.parse(e.data).comp;
    } catch {
      // aviso antigo, sem campeonato: atualiza
    }
    if (!comp || comp === state.comp) refresh();
    else if (alerts.on) checkOtherComp(comp);
  });
}

// No celular a página "dorme" em segundo plano: ao voltar, atualiza na hora.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

// Quando o dia vira, redesenha a tela: "Amanhã" passa a "Hoje" sem esperar a próxima atualização
function scheduleMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
  setTimeout(() => {
    refresh();
    scheduleMidnight();
  }, next - now);
}

applyRoute();
scheduleMidnight();
connectLive();
setInterval(refresh, REFRESH_MS);
