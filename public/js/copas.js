// ---------- Copas (Libertadores, Copa do Brasil, Sul-Americana) ----------

state.lib = { stage: null };

async function libMeta() {
  const o = await api(cupApi('/overview'));
  const updated = new Date(o.updatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  $('#meta').textContent = `${CUP_INFO[state.comp].title} · ${o.currentStage.label} · fonte: ${o.source} · atualizado às ${updated}`;
  $(`#${state.comp}-fase`).textContent = o.currentStage.label;
  return o;
}

// Linha de um time dentro do cartão do confronto
function tieTeam(t, goals, won, chance, tieId) {
  if (!t) return `<div class="tt tbd"><span class="badge">?</span><span>A definir</span></div>`;
  // Confronto em aberto: tocar no time escolhe quem passa ("e se")
  const pick = tieId ? ` data-tie="${tieId}" data-team="${t.id}" role="button" title="E se o ${escapeHtml(t.shortName)} passar?"` : '';
  const chosen = tieId && state.cupPicks[state.comp]?.[tieId] === t.id;
  return `<div class="tt ${won ? 'passou' : ''} ${chosen ? 'escolhido' : ''}"${pick}>${crestImg(t)}<a href="${teamHref(t.id)}">${escapeHtml(t.shortName)}</a>
    ${chance != null ? `<small class="chance-t">${pct(chance)}</small>` : ''}<b>${goals ?? ''}</b></div>`;
}

function tieCard(t, champions) {
  const [a, b] = t.teams;
  const legs = t.legs
    .map((l) => {
      const played = l.status === 'FINISHED' || l.status === 'LIVE';
      const date = dayName(l.utcDate);
      const pen = l.penalties ? ` (pên. ${l.penalties[0]}–${l.penalties[1]})` : '';
      if (l.home.tbd) return `<span class="perna">${date} · jogo único, campo neutro</span>`;
      return `<a href="${jogoHref(l.id)}" class="perna">${played ? `${escapeHtml(l.home.tla)} ${l.homeGoals}–${l.awayGoals} ${escapeHtml(l.away.tla)}${pen}` : `${date} · ${escapeHtml(l.home.tla)} x ${escapeHtml(l.away.tla)}`}${l.status === 'LIVE' ? ' <span class="live-tag">●</span>' : ''}</a>`;
    })
    .join('');
  // Final ainda sem os dois times: mostra quem tem mais chance de chegar
  const finalists =
    !a && champions?.length
      ? `<div class="provaveis">${champions
          .filter((c) => c.final > 0.005)
          .map((c) => `<span>${crestImg(c.team)}${escapeHtml(c.team.shortName)} <b>${pct(c.final)}</b></span>`)
          .join('')}</div>`
      : '';
  const played = t.legs.some((l) => l.status === 'FINISHED' || l.status === 'LIVE');
  const open = !t.winner && a && b ? t.id : null;
  return `<div class="tie ${t.winner ? 'decidido' : ''} ${open ? 'aberto' : ''}">
    ${tieTeam(a, played && a ? t.aggregate[0] : null, t.winner === a?.id, t.advance, open)}
    ${tieTeam(b, played && b ? t.aggregate[1] : null, t.winner === b?.id, t.advance != null ? 1 - t.advance : null, open)}
    ${finalists}
    <div class="pernas">${legs}</div>
  </div>`;
}

async function loadLibBracket() {
  const comp = state.comp;
  const o = await libMeta();
  // Com palpites, as chances vêm do "e se" (e mostram quanto era antes)
  let champions = o.champions;
  if (hasPicks(comp)) {
    const w = await postJson(cupApi('/whatif'), { picks: state.cupPicks[comp] });
    // O servidor devolve só os palpites que ainda valem (confronto decidido sai)
    state.cupPicks[comp] = Object.fromEntries(Object.entries(w.picks).map(([k, v]) => [k, Number(v)]));
    saveCupPicks();
    champions = w.champions.filter((c) => c.champion > 0 || c.base > 0);
  }
  const picked = hasPicks(comp);
  $('#lib-campeao').innerHTML = `<div class="corrida-card">${champions
    .map(
      (c) => `<div class="linha">${crestImg(c.team)}
      <div class="trilho" style="--c:var(--amarelo)"><div data-w="${c.champion}"></div><span><a href="${teamHref(c.team.id)}">${escapeHtml(c.team.shortName)}</a></span></div>
      <b>${pct(c.champion)}${picked && Math.abs(c.champion - c.base) >= 0.005 ? `<span class="antes">antes ${pct(c.base)}</span>` : ''}</b></div>`,
    )
    .join('')}</div>
    ${picked ? '<p class="muted">Com os seus palpites (em amarelo no chaveamento). <button class="small-btn" id="cup-picks-clear">Desfazer palpites</button></p>' : ''}`;
  $('#lib-bracket').innerHTML = o.stages
    .map((s) => `<div class="fase-col"><h3>${escapeHtml(s.label)}</h3><div class="fase-ties">${s.ties.map((t) => tieCard(t, s.key === 'FINAL' ? o.champions : null)).join('')}</div></div>`)
    .join('');
  $('#cup-slogan').textContent = CUP_INFO[state.comp].slogan;
  const jogos = CUP_INFO[state.comp].model;
  $('#lib-nota').textContent = `Chances calculadas com ${o.simulations.toLocaleString('pt-BR')} simulações do mata-mata, usando o modelo ajustado com os jogos ${jogos}. A final é em jogo único, em campo neutro. E se…? Toque num time de um confronto em aberto para ver como ficam as chances se ele passar.`;
  growBars($('#lib-chave'));
}

async function loadLibMatches() {
  const data = await api(cupApi(`/matches${state.lib.stage ? `?stage=${state.lib.stage}` : ''}`));
  state.lib.stage = data.stage.key;
  libMeta().catch(() => {});
  $('#lib-fases').innerHTML = data.stages
    .map((s) => `<button data-stage="${s.key}" class="${s.key === data.stage.key ? 'on' : ''}">${escapeHtml(s.label)}</button>`)
    .join('');
  // Na fase de grupos, separa os jogos por rodada
  const cards = data.matches.map((m) => matchCard(m, data.watchUrl));
  $('#lib-matches').innerHTML = cards.length ? cards.join('') : '<div class="empty">Sem jogos nesta fase.</div>';
  growBars($('#lib-matches'));
}

async function loadLibGroups() {
  const data = await api(cupApi('/groups'));
  libMeta().catch(() => {});
  // Legenda: o que significa a cor de cada posição nesta copa
  const legend = CUP_INFO[state.comp].legend;
  $('#grupos-legenda-lib').lastChild.textContent = ` ${legend.lib}`;
  $('#grupos-legenda-sul').hidden = !legend.sul;
  $('#lib-groups').innerHTML = data.groups
    .map(
      (g) => `<div class="grupo"><h3>Grupo ${escapeHtml(g.group)}</h3><div class="table-wrap"><table class="standings mini-tab">
      <thead><tr><th>#</th><th class="left">Time</th><th>P</th><th>J</th><th>SG</th><th>Últimos</th></tr></thead><tbody>${g.rows
        .map(
          (r) => `<tr class="${r.position <= data.zones.libertadores ? 'lib' : r.position <= data.zones.sulamericana ? 'sul' : ''}">
          <td class="pos">${r.position}</td><td class="left">${teamHtml(r.team)}</td><td class="points">${r.points}</td><td>${r.played}</td>
          <td>${r.goalDiff > 0 ? '+' : ''}${r.goalDiff}</td><td><span class="form">${r.form.map((x, i) => formLink(x, r.formMatches[i])).join('')}</span></td></tr>`,
        )
        .join('')}</tbody></table></div></div>`,
    )
    .join('');
}

async function loadLibScorers() {
  const data = await api(cupApi('/scorers'));
  libMeta().catch(() => {});
  const info = CUP_INFO[state.comp];
  $('#gols-nota').textContent = `da ${info.name}`;
  $('#gols-aviso').hidden = !info.scorersNote;
  $('#gols-aviso').textContent = info.scorersNote ?? '';
  $('#lib-scorers').innerHTML = scorersTable(data.scorers);
}

// Toque num time de confronto em aberto: escolhe (ou desfaz) quem passa
$('#lib-bracket').addEventListener('click', (e) => {
  const row = e.target.closest('.tt[data-tie]');
  if (!row || e.target.closest('a')) return;
  const picks = (state.cupPicks[state.comp] ??= {});
  const team = Number(row.dataset.team);
  if (picks[row.dataset.tie] === team) delete picks[row.dataset.tie];
  else picks[row.dataset.tie] = team;
  saveCupPicks();
  refresh();
});

$('#lib-campeao').addEventListener('click', (e) => {
  if (!e.target.closest('#cup-picks-clear')) return;
  state.cupPicks[state.comp] = {};
  saveCupPicks();
  refresh();
});

$('#lib-fases').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-stage]');
  if (!b) return;
  state.lib.stage = b.dataset.stage;
  refresh();
});

// Página de um time da Libertadores (qualquer clube, brasileiro ou não)
const JOURNEY_LABEL = { passou: 'Passou', eliminado: 'Eliminado' };

function journeyStep(s) {
  if (s.stage === 'GROUP_STAGE') {
    const status = s.result === 'passou' ? 'passou' : s.result === 'eliminado' ? 'eliminado' : 'aberto';
    const note = s.result === 'passou' ? 'Classificado' : s.sulamericana ? 'Foi para a Sul-Americana' : s.result === 'eliminado' ? 'Eliminado' : 'Em disputa';
    return `<div class="passo ${status}"><small>${escapeHtml(s.label)}</small>
      <b>${s.position}º no Grupo ${escapeHtml(s.group)}</b><span>${s.points} pontos · ${note}</span></div>`;
  }
  if (s.reach != null) {
    return `<div class="passo futuro"><small>${escapeHtml(s.label)}</small><b>Chance de chegar</b><span>${pct(s.reach)}</span></div>`;
  }
  const opp = s.opponent ? `${crestImg(s.opponent)} ${escapeHtml(s.opponent.shortName)}` : 'A definir';
  const status = s.result ?? 'aberto';
  const placar = s.played ? `<em>${s.aggregate[0]} – ${s.aggregate[1]}</em>` : '';
  const note = s.result ? JOURNEY_LABEL[s.result] : s.advance != null ? `Chance de passar: ${pct(s.advance)}` : 'Em disputa';
  return `<div class="passo ${status}"><small>${escapeHtml(s.label)}</small><b>${opp} ${placar}</b><span>${note}</span></div>`;
}

async function loadLibTeam() {
  const d = await api(cupApi(`/time/${state.lib.teamId}`));
  libMeta().catch(() => {});
  const t = d.team;
  const cup = CUP_INFO[state.comp].name;
  document.title = `${t.shortName} · ${cup}`;
  $('#lib-time-back').href = `#/${state.comp}/${CUP_INFO[state.comp].pages.includes('grupos') ? 'grupos' : 'chave'}`;
  $('#lib-time-back').textContent = `← ${cup}`;
  $('#lib-team-caminho').textContent = `Caminho na ${cup}`;
  // Clube da Série A: link para a página completa dele (Brasileirão e todas as copas)
  $('#lib-time-bsa').hidden = true;
  api('/api/overview').then((o) => {
    $('#lib-time-bsa').hidden = !o.standings.some((r) => r.team.id === t.id);
    $('#lib-time-bsa').href = `#/time/${t.id}`;
  }, () => {});
  const out = d.journey.find((s) => s.result === 'eliminado');
  const won = d.journey.find((s) => s.stage === 'FINAL' && s.result === 'passou');
  const situation = won
    ? `Campeão da ${cup}`
    : out
      ? `Eliminado: ${out.label.toLowerCase()}${out.sulamericana ? ' (foi para a Sul-Americana)' : ''}`
      : `Na disputa · ${pct(d.champion)} de chance de título`;
  const icon = t.crest ? `<img class="crest big" src="${escapeHtml(t.crest)}" alt="" />` : `<span class="badge big">${escapeHtml(t.tla)}</span>`;
  $('#lib-team-header').innerHTML = `${icon}<div><h2>${escapeHtml(t.name)}</h2><p class="muted">${situation}</p></div>`;

  const s = d.stats;
  const r = d.ratings;
  const rating = (v, kind) => ratingText(v, kind).replace('da liga', `da ${cup}`);
  $('#lib-team-stats').innerHTML = [
    statCard('Campanha', `${s.won}V ${s.drawn}E ${s.lost}D`, `${s.played} jogos · ${s.goalsFor} gols marcados, ${s.goalsAgainst} sofridos`),
    statCard('Chance de título', pct(d.champion), out ? 'já foi eliminado' : 'pelas simulações do mata-mata'),
    statCard('Ataque', `${r.attackRank}º`, `de ${r.of} times · ${rating(r.attack, 'attack')}`),
    statCard('Defesa', `${r.defenseRank}º`, `de ${r.of} times · ${rating(r.defense, 'defense')}`),
  ].join('');

  $('#lib-team-journey').innerHTML = d.journey.length ? d.journey.map(journeyStep).join('') : '<div class="empty">Sem jogos ainda.</div>';

  $('#lib-team-upcoming-box').hidden = !d.upcoming.length;
  $('#lib-team-upcoming').innerHTML = d.upcoming.map((m) => matchCard(m, d.watchUrl)).join('');

  $('#lib-team-group-box').hidden = !d.group;
  if (d.group) {
    $('#lib-team-group-title').textContent = `Grupo ${d.group.name}`;
    $('#lib-team-group').innerHTML = `<div class="table-wrap"><table class="standings mini-tab">
      <thead><tr><th>#</th><th class="left">Time</th><th>P</th><th>J</th><th>SG</th></tr></thead><tbody>${d.group.rows
        .map((row) => {
          const zone = row.position <= d.zones.libertadores ? 'lib' : row.position <= d.zones.sulamericana ? 'sul' : '';
          return `<tr class="${zone} ${row.team.id === t.id ? 'eu' : ''}">
          <td class="pos">${row.position}</td><td class="left">${teamHtml(row.team)}</td><td class="points">${row.points}</td><td>${row.played}</td>
          <td>${row.goalDiff > 0 ? '+' : ''}${row.goalDiff}</td></tr>`;
        })
        .join('')}</tbody></table></div>`;
  }
  $('#lib-team-scorers').innerHTML = d.scorers.length
    ? `<div class="table-wrap"><table><thead><tr><th class="left">Jogador</th><th>Gols</th><th>Assist.</th></tr></thead><tbody>${d.scorers
        .map((p) => `<tr><td class="left">${escapeHtml(p.player)}</td><td class="points">${p.goals}</td><td>${p.assists ?? '–'}</td></tr>`)
        .join('')}</tbody></table></div>`
    : '<div class="empty">Nenhum jogador do time entre os artilheiros da competição.</div>';

  $('#lib-team-results').innerHTML = d.results.length
    ? `<div class="table-wrap"><table>
    <thead><tr><th>Fase</th><th>Data</th><th class="left">Adversário</th><th>Placar</th><th></th></tr></thead>
    <tbody>${d.results
      .map((res) => {
        const m = res.match;
        const date = new Date(m.utcDate).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        const pen = m.penalties ? ` <small>(pên. ${m.penalties[0]}–${m.penalties[1]})</small>` : '';
        const score = `${m.home.tla} ${m.homeGoals}×${m.awayGoals} ${m.away.tla}`;
        return `<tr class="linha-jogo" data-jogo="${m.id}">
          <td>${escapeHtml(res.stageLabel)}</td>
          <td>${date}</td>
          <td class="left"><span class="matchup">${teamHtml(res.opponent)} <span class="venue">${res.home ? 'casa' : 'fora'}</span></span></td>
          <td class="points">${escapeHtml(m.home.tla)} ${m.homeGoals} × ${m.awayGoals} ${escapeHtml(m.away.tla)}${pen}</td>
          <td><span class="form">${formLink(res.result, { id: m.id, score })}</span></td>
        </tr>`;
      })
      .join('')}</tbody></table></div>`
    : '<div class="empty">Nenhum jogo encerrado ainda.</div>';
}
