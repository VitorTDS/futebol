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

applyRoute();
connectLive();
setInterval(refresh, REFRESH_MS);
