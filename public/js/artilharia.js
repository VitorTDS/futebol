// ---------- Artilharia ----------

async function loadScorers() {
  const data = await api('/api/scorers');
  if (!data.scorers) {
    $('#scorers').innerHTML = `<div class="empty">
      A artilharia aparece quando você usa dados reais.<br />
      Coloque seu token em <code>FOOTBALL_DATA_TOKEN</code> no arquivo <code>.env</code> e reinicie o servidor.
    </div>`;
    return;
  }
  $('#scorers').innerHTML = scorersTable(data.scorers);
}

function scorersTable(scorers) {
  if (!scorers?.length) return '<div class="empty">Ainda não há artilharia.</div>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>#</th><th class="left">Jogador</th><th class="left">Time</th><th>Gols</th><th>Assist.</th><th>Pênaltis</th></tr></thead>
    <tbody>${scorers
      .map(
        (s, i) => `<tr>
          <td>${i + 1}</td>
          <td class="left">${escapeHtml(s.player)}</td>
          <td class="left">${teamHtml(s.team)}</td>
          <td class="points">${s.goals}</td>
          <td>${s.assists ?? '–'}</td>
          <td>${s.penalties ?? '–'}</td>
        </tr>`,
      )
      .join('')}</tbody>
  </table></div>`;
}
