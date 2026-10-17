// ---------- Compartilhar como imagem (WhatsApp etc.) ----------
// A imagem é desenhada aqui mesmo, num <canvas>. No celular abre o menu de
// compartilhar do sistema; no computador, baixa o arquivo PNG.

const SHARE_W = 1080;

/** Escudo pelo próprio servidor (sem isso o navegador não deixa salvar o desenho) */
function loadCrest(team) {
  return new Promise((resolve) => {
    if (!team?.crest) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `/api/escudo?u=${encodeURIComponent(team.crest)}`;
  });
}

/** Cores do campeonato aberto (as mesmas da tela) */
function shareTheme() {
  const css = getComputedStyle(document.body);
  const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return { bg: v('--lousa', '#14321f'), bg2: v('--lousa-2', '#1b4029'), accent: v('--amarelo', '#ffd23f'), text: '#f1f5ea', mute: v('--giz-mute', '#b9c4b3') };
}

async function shareCanvas(height, title, subtitle) {
  await document.fonts.ready;
  const c = document.createElement('canvas');
  c.width = SHARE_W;
  c.height = height;
  const g = c.getContext('2d');
  const t = shareTheme();
  g.fillStyle = t.bg;
  g.fillRect(0, 0, SHARE_W, height);
  g.fillStyle = t.accent;
  g.fillRect(0, 0, SHARE_W, 16);
  g.textAlign = 'center';
  g.fillStyle = t.text;
  g.font = '64px "Archivo Black", sans-serif';
  g.fillText(title.toUpperCase(), SHARE_W / 2, 110);
  if (subtitle) {
    g.fillStyle = t.mute;
    g.font = '600 30px Archivo, sans-serif';
    g.fillText(subtitle, SHARE_W / 2, 160);
  }
  // Rodapé
  g.fillStyle = t.mute;
  g.font = '600 26px Archivo, sans-serif';
  g.fillText('⚽ Painel do futebol · previsões por simulação', SHARE_W / 2, height - 40);
  return { c, g, t };
}

/** Texto que cabe na largura (corta com "…") */
function fitText(g, text, max) {
  if (g.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && g.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s}…`;
}

async function sendImage(canvas, name, text) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const file = new File([blob], name, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // a pessoa desistiu
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const pctText = (p) => pct(p).replace('–', '0%');

// ---------- Jogo ----------

async function shareMatch() {
  const d = state.jogo.data;
  if (!d) return;
  const m = d.match;
  const comp = d.competition ? `${compName(d.competition)} · ${d.stageLabel}` : `Brasileirão · Rodada ${m.matchday}`;
  const played = m.status === 'FINISHED' || m.status === 'LIVE';
  const when = kickoffText(m.utcDate, { long: true });
  const { c, g, t } = await shareCanvas(1080, played ? (m.status === 'LIVE' ? 'Ao vivo' : 'Fim de jogo') : 'Vem jogo aí', comp);
  const [ch, ca] = await Promise.all([loadCrest(m.home), loadCrest(m.away)]);
  const crest = (img, x) => img && g.drawImage(img, x - 110, 230, 220, 220);
  crest(ch, 260);
  crest(ca, 820);
  g.fillStyle = t.text;
  g.font = '44px "Archivo Black", sans-serif';
  g.fillText(fitText(g, m.home.shortName.toUpperCase(), 380), 260, 510);
  g.fillText(fitText(g, m.away.shortName.toUpperCase(), 380), 820, 510);
  g.fillStyle = t.accent;
  g.font = `${played ? 150 : 110}px "Archivo Black", sans-serif`;
  g.fillText(played ? `${m.homeGoals ?? 0}–${m.awayGoals ?? 0}` : 'x', 540, 400);
  g.fillStyle = t.mute;
  g.font = '600 30px Archivo, sans-serif';
  g.fillText(played ? (m.penalties ? `pênaltis ${m.penalties[0]}–${m.penalties[1]}` : '') : when, 540, 590);

  const p = m.prediction;
  if (p) {
    // Barra de chances: mandante, empate, visitante
    const x0 = 120;
    const w = SHARE_W - 240;
    const parts = [
      [p.pHome, '#1f9d55'],
      [p.pDraw, '#f2c94c'],
      [p.pAway, '#2f6fde'],
    ];
    let x = x0;
    for (const [v, color] of parts) {
      g.fillStyle = color;
      g.fillRect(x, 680, w * v, 40);
      x += w * v;
    }
    g.font = '700 34px Archivo, sans-serif';
    g.fillStyle = t.text;
    g.textAlign = 'left';
    g.fillText(`${pctText(p.pHome)} ${m.home.tla}`, x0, 780);
    g.textAlign = 'right';
    g.fillText(`${m.away.tla} ${pctText(p.pAway)}`, x0 + w, 780);
    g.textAlign = 'center';
    g.fillText(`Empate ${pctText(p.pDraw)}`, 540, 780);
    g.fillStyle = t.accent;
    g.font = '40px "Archivo Black", sans-serif';
    g.fillText(`Placar mais provável: ${p.likelyScore[0]} × ${p.likelyScore[1]}`, 540, 880);
  } else if (d.tie?.winner) {
    const w = d.tie.winner === d.tie.teams[0].id ? d.tie.teams[0] : d.tie.teams[1];
    g.fillStyle = t.accent;
    g.font = '44px "Archivo Black", sans-serif';
    g.fillText(`${w.shortName} avançou`, 540, 760);
  }
  await sendImage(c, `${m.home.tla}-x-${m.away.tla}.png`.toLowerCase(), `${m.home.shortName} x ${m.away.shortName} · ${comp}`);
}

// ---------- Tabela ----------

async function shareStandings() {
  const data = await api('/api/overview');
  const rows = data.standings;
  const rowH = 74;
  const top = 240;
  const { c, g, t } = await shareCanvas(top + rows.length * rowH + 110, 'Brasileirão', `Rodada ${data.currentMatchday} · chances pelas simulações`);
  // Cabeçalho das colunas
  g.font = '700 24px Archivo, sans-serif';
  g.fillStyle = t.mute;
  g.textAlign = 'right';
  // Colunas (posição da borda direita de cada uma)
  const COL = { pts: 620, title: 770, lib: 915, rel: 1050 };
  const cols = [
    [COL.pts, 'PTS'],
    [COL.title, 'TÍTULO'],
    [COL.lib, 'LIBERTA'],
    [COL.rel, 'QUEDA'],
  ];
  for (const [x, label] of cols) g.fillText(label, x, top - 20);
  const crests = await Promise.all(rows.map((r) => loadCrest(r.team)));
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    if (i % 2 === 0) {
      g.fillStyle = t.bg2;
      g.fillRect(24, y, SHARE_W - 48, rowH);
    }
    // Faixa da zona: Libertadores provável, Sul-Americana, rebaixamento
    const zone = r.position <= data.zones.libertadores ? '#1f9d55' : r.position <= data.zones.sulamericana ? '#2f6fde' : r.position > rows.length - data.zones.relegation ? '#d7263d' : null;
    if (zone) {
      g.fillStyle = zone;
      g.fillRect(24, y, 10, rowH);
    }
    const mid = y + rowH / 2 + 12;
    g.fillStyle = t.text;
    g.textAlign = 'right';
    g.font = '700 32px Archivo, sans-serif';
    g.fillText(String(r.position), 100, mid);
    if (crests[i]) g.drawImage(crests[i], 120, y + 12, 50, 50);
    g.textAlign = 'left';
    g.fillText(fitText(g, r.team.shortName, 340), 190, mid);
    g.textAlign = 'right';
    g.font = '36px "Archivo Black", sans-serif';
    g.fillText(String(r.points), COL.pts, mid);
    g.font = '700 30px Archivo, sans-serif';
    g.fillStyle = t.accent;
    g.fillText(pctText(r.outlook.title), COL.title, mid);
    g.fillStyle = t.text;
    g.fillText(pctText(r.outlook.libertadores), COL.lib, mid);
    g.fillText(pctText(r.outlook.relegation), COL.rel, mid);
  });
  await sendImage(c, `brasileirao-rodada-${data.currentMatchday}.png`, `Brasileirão, rodada ${data.currentMatchday}`);
}

// ---------- Cenário do "e se" ----------

async function shareWhatif() {
  const ese = state.ese;
  if (!ese.result) return;
  const teamsById = new Map(ese.data.standings.map((r) => [r.team.id, r.team]));
  const base = new Map(ese.result.base.map((o) => [o.teamId, o]));
  const matchesById = new Map(ese.data.matches.map((m) => [String(m.id), m]));
  const picks = Object.entries(ese.picks)
    .map(([id, p]) => ({ m: matchesById.get(id), p }))
    .filter((x) => x.m);
  // Quem mais mudou (o "seu time" primeiro)
  const myTeam = Number($('#ese-team').value) || null;
  const changes = ese.result.teams
    .map((o) => {
      const b = base.get(o.teamId);
      const diffs = [
        ['título', o.title, b.title],
        ['Libertadores', o.libertadores, b.libertadores],
        ['rebaixamento', o.relegation, b.relegation],
      ].sort((x, y) => Math.abs(y[1] - y[2]) - Math.abs(x[1] - x[2]));
      return { team: teamsById.get(o.teamId), main: diffs[0], size: Math.abs(diffs[0][1] - diffs[0][2]) };
    })
    .filter((x) => x.team && (x.size >= 0.02 || x.team.id === myTeam))
    .sort((a, b) => (b.team.id === myTeam) - (a.team.id === myTeam) || b.size - a.size)
    .slice(0, 6);
  const pickRows = picks.slice(0, 8);
  const top = 230;
  const height = top + 60 + pickRows.length * 60 + 120 + changes.length * 90 + 120;
  const { c, g, t } = await shareCanvas(height, 'E se…?', 'Brasileirão · simulação com os meus palpites');
  g.textAlign = 'left';
  g.fillStyle = t.accent;
  g.font = '34px "Archivo Black", sans-serif';
  g.fillText(picks.length ? 'SE ACONTECER ISSO:' : 'SEM PALPITES', 70, top);
  g.font = '700 32px Archivo, sans-serif';
  g.fillStyle = t.text;
  pickRows.forEach(({ m, p }, i) => {
    const txt = p === 'H' ? `${m.home.shortName} vence ${m.away.shortName}` : p === 'A' ? `${m.away.shortName} vence ${m.home.shortName} (fora)` : `${m.home.shortName} e ${m.away.shortName} empatam`;
    g.fillText(fitText(g, `• ${txt}`, SHARE_W - 140), 70, top + 60 + i * 60);
  });
  if (picks.length > pickRows.length) g.fillText(`… e mais ${picks.length - pickRows.length}`, 70, top + 60 + pickRows.length * 60);
  let y = top + 60 + pickRows.length * 60 + 80;
  g.fillStyle = t.accent;
  g.font = '34px "Archivo Black", sans-serif';
  g.fillText('FICA ASSIM:', 70, y);
  const crests = await Promise.all(changes.map((x) => loadCrest(x.team)));
  changes.forEach((x, i) => {
    const yy = y + 40 + i * 90;
    if (crests[i]) g.drawImage(crests[i], 70, yy, 60, 60);
    const [label, now, before] = x.main;
    const pp = Math.round((now - before) * 100);
    g.fillStyle = t.text;
    g.font = '700 34px Archivo, sans-serif';
    g.fillText(fitText(g, `${x.team.shortName}: ${pctText(now)} de ${label}`, 700), 150, yy + 42);
    g.textAlign = 'right';
    const bad = label === 'rebaixamento' ? pp > 0 : pp < 0;
    g.fillStyle = pp === 0 ? t.mute : bad ? '#ff6b6b' : '#5ee08a';
    g.fillText(pp === 0 ? 'igual' : `${pp > 0 ? '▲ +' : '▼ '}${pp} pts`, SHARE_W - 70, yy + 42);
    g.textAlign = 'left';
  });
  await sendImage(c, 'e-se.png', 'E se…? Meu cenário no Brasileirão');
}

for (const [sel, fn] of [
  ['#jogo-share', shareMatch],
  ['#tabela-share', shareStandings],
  ['#ese-share', shareWhatif],
]) {
  $(sel).addEventListener('click', (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    fn()
      .catch((err) => showBanner(`Não foi possível gerar a imagem: ${err.message}`, true))
      .finally(() => (b.disabled = false));
  });
}
