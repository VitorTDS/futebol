// ---------- Agenda: jogos de todos os campeonatos ----------

state.agenda = { days: 7, mine: store.get('agenda.meus', false), matches: [] };

/** Times que a pessoa segue: os do sino e o "seu time" do "e se" */
function followedTeams() {
  const ids = new Set(alerts.teams);
  const mine = Number(store.get('meuTime', '')) || null;
  if (mine) ids.add(mine);
  return ids;
}

/** "Hoje", "Amanhã" ou "sábado, 24/10", no fuso do aparelho */
function dayLabel(date) {
  const key = (d) => d.toLocaleDateString('pt-BR');
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86_400_000);
  const name = date.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });
  if (key(date) === key(today)) return `Hoje · ${name}`;
  if (key(date) === key(tomorrow)) return `Amanhã · ${name}`;
  return name;
}


async function loadAgenda() {
  const ag = state.agenda;
  const data = await api(`/api/agenda?dias=${ag.days}`);
  const followed = followedTeams();
  $('#agenda-meus').checked = ag.mine && followed.size > 0;
  $('#agenda-meus').disabled = !followed.size;
  $('#agenda-nota').textContent = followed.size ? '' : 'Para filtrar, escolha seus times no sino (🔔) ou o "seu time" no "E se".';
  const show = ag.mine && followed.size ? data.matches.filter((m) => followed.has(m.home.id) || followed.has(m.away.id)) : data.matches;
  ag.matches = show;
  $('#agenda-ics').disabled = !show.some((m) => m.status !== 'FINISHED');

  // Agrupa por dia (no fuso do aparelho)
  const days = new Map();
  for (const m of show) {
    const key = new Date(m.utcDate).toLocaleDateString('pt-BR');
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(m);
  }
  $('#agenda-lista').innerHTML = show.length
    ? [...days.values()]
        .map(
          (ms) => `<h3 class="agenda-dia">${escapeHtml(dayLabel(new Date(ms[0].utcDate)))}</h3>
          <div class="matches">${ms.map((m) => agendaCard(m, data.watchUrl)).join('')}</div>`,
        )
        .join('')
    : `<div class="empty">Nenhum jogo nos próximos ${ag.days} dias${ag.mine ? ' dos times que você segue' : ''}.</div>`;
  growBars($('#agenda-lista'));
}

/** Cartão do jogo com o campeonato sempre à vista e o botão de pôr na agenda */
function agendaCard(m, watchUrl) {
  const card = matchCard({ ...m, comp: m.comp }, watchUrl, { showComp: true });
  if (m.status === 'FINISHED') return card;
  return card.replace(
    /<\/article>$/,
    `<button class="add-cal small-btn" data-cal="${m.comp}:${m.id}" title="Pôr este jogo na agenda do celular">📅 Pôr na agenda</button></article>`,
  );
}

// ---------- Agenda do celular (.ics: Google Agenda, iPhone, Outlook) ----------

function icsText(matches) {
  const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  // Texto no formato do .ics: vírgula, ponto e vírgula e barra precisam de "\"
  const text = (s) => String(s).replace(/[\\;,]/g, (c) => `\\${c}`);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Painel do futebol//PT-BR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const m of matches) {
    const start = new Date(m.utcDate);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${m.comp}-${m.id}@painel-futebol`,
      `DTSTAMP:${stamp(new Date())}`,
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(new Date(start.getTime() + 2 * 3_600_000))}`,
      `SUMMARY:${text(`${m.home.shortName} x ${m.away.shortName}`)}`,
      `DESCRIPTION:${text(`${compName(m.comp)} · ${m.stageLabel}`)}`,
      `URL:${location.origin}/${jogoHref(m.id, m.comp)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

function downloadIcs(matches, name) {
  const url = URL.createObjectURL(new Blob([icsText(matches)], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

$('#agenda-ics').addEventListener('click', () => {
  const next = state.agenda.matches.filter((m) => m.status !== 'FINISHED');
  if (next.length) downloadIcs(next, 'jogos.ics');
});

$('#agenda-lista').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cal]');
  if (!b) return;
  const [comp, id] = b.dataset.cal.split(':');
  const m = state.agenda.matches.find((x) => x.comp === comp && String(x.id) === id);
  if (m) downloadIcs([m], `${m.home.tla}-x-${m.away.tla}.ics`.toLowerCase());
});

$('#agenda-meus').addEventListener('change', (e) => {
  state.agenda.mine = e.target.checked;
  store.set('agenda.meus', state.agenda.mine);
  refresh();
});

$('#agenda-dias').addEventListener('change', (e) => {
  state.agenda.days = Number(e.target.value);
  refresh();
});
