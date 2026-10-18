// Teste das telas: sobe o servidor, abre o Chrome instalado (sem janela) e passa
// por todas as páginas e pelos botões principais, no computador e no celular.
// Pega o tipo de erro que os testes de cálculo não pegam (ex.: uma tela que
// quebra ao carregar). Usa os dados reais (.env) e a internet.
//
//   npm run test:telas
//
// Outro Chrome: CHROME_PATH="C:\...\chrome.exe" npm run test:telas
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3095;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(import.meta.dirname, '..');

let server: ChildProcess;
let browser: Browser;

before(async () => {
  assert.ok(existsSync(CHROME), `Chrome não encontrado em ${CHROME} (use CHROME_PATH)`);
  // O que o servidor escreve fica num arquivo, para investigar quando um teste falha
  const log = path.join(tmpdir(), 'painel-test-telas.log');
  server = spawn(process.execPath, ['src/server.ts'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = createWriteStream(log);
  server.stdout!.pipe(out);
  server.stderr!.pipe(out);
  console.log(`registro do servidor: ${log}`);
  // Espera o servidor responder
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      // ainda subindo
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run'] });
});

after(async () => {
  await browser?.close();
  server?.kill();
});

/** Abre o painel e guarda todo erro de JavaScript que aparecer */
async function openPanel(width: number, height: number) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, isMobile: width < 700, hasTouch: width < 700 });
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`erro na página: ${(err as Error).message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/ERR_ABORTED|Failed to fetch|favicon/.test(msg.text())) errors.push(`console: ${msg.text()}`);
  });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60_000 });
  // Erro na abertura vira aviso na tela (e some na atualização seguinte): confere já
  const banner = await page.$eval('#banner', (b) => ((b as HTMLElement).hidden ? null : b.textContent));
  if (banner) errors.push(`aviso na abertura: ${banner}`);
  return { page, errors };
}

/** Vai para um endereço do painel e espera a tela ter conteúdo (a primeira carga de algumas demora) */
async function visit(page: Page, hash: string) {
  await page.evaluate((h) => (location.hash = h), hash);
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('.panel.active');
      const banner = document.querySelector('#banner') as HTMLElement;
      return (panel && (panel as HTMLElement).innerText.length > 120) || (banner && !banner.hidden);
    },
    // Logo depois de ligar, a football-data pode mandar esperar até 1 minuto (limite do plano grátis)
    { timeout: 90_000 },
  );
  return page.evaluate(() => ({
    banner: (document.querySelector('#banner') as HTMLElement).hidden ? null : document.querySelector('#banner')!.textContent,
    text: (document.querySelector('.panel.active') as HTMLElement).innerText.length,
    // clientWidth é a largura da tela; no modo celular, innerWidth cresce junto com a página
    tooWide: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  }));
}

const PAGES = [
  '#/tabela',
  '#/jogos',
  '#/ese',
  '#/evolucao',
  '#/acertos',
  '#/artilharia',
  '#/scout',
  '#/agenda',
  '#/lib/chave',
  '#/lib/jogos',
  '#/lib/grupos',
  '#/lib/gols',
  '#/cdb/chave',
  '#/cdb/jogos',
  '#/cdb/gols',
  '#/sula/chave',
  '#/sula/grupos',
  '#/sula/gols',
  '#/serieb/tabela',
  '#/serieb/jogos',
  '#/serieb/ese',
];

/** Páginas que dependem de um id (time, jogo): pega um de verdade na API */
async function detailPages(): Promise<string[]> {
  const get = (p: string) => fetch(`${BASE}${p}`).then((r) => r.json());
  const [bsa, lib, b] = await Promise.all([get('/api/overview'), get('/api/lib/matches'), get('/api/serieb/overview')]);
  const game = (await get('/api/matches')).matches[0];
  const bGame = (await get('/api/serieb/matches')).matches[0];
  const team = bsa.standings[0].team.id;
  return [`#/time/${team}`, `#/jogo/${game.id}`, `#/lib/jogo/${lib.matches[0].id}`, `#/lib/time/${team}`, `#/serieb/time/${b.standings[0].team.id}`, `#/serieb/jogo/${bGame.id}`];
}

for (const [label, width, height] of [
  ['computador', 1366, 900],
  ['celular', 390, 844],
] as const) {
  test(`todas as telas abrem sem erro (${label})`, async () => {
    const { page, errors } = await openPanel(width, height);
    const problems: string[] = [];
    for (const hash of [...PAGES, ...(await detailPages())]) {
      const r = await visit(page, hash).catch((err) => ({ banner: `não carregou: ${(err as Error).message}`, text: 0, tooWide: false }));
      if (r.banner) problems.push(`${hash}: ${r.banner}`);
      if (r.tooWide) problems.push(`${hash}: mais larga que a tela`);
    }
    await page.close();
    assert.deepEqual([...problems, ...errors], []);
  });
}

test('botões principais funcionam', async () => {
  const { page, errors } = await openPanel(1366, 900);

  // Palpite no "e se" muda a contagem; "Limpar" desfaz
  await visit(page, '#/ese');
  await page.click('#ese-matches button[data-p="H"]');
  await page.waitForFunction(() => document.querySelector('#ese-count')!.textContent!.startsWith('1 jogo'));
  await page.click('#ese-clear');
  await page.waitForFunction(() => document.querySelector('#ese-count')!.textContent === 'Nenhum jogo escolhido');

  // Palpite no chaveamento da copa marca o time e mostra "antes"
  await visit(page, '#/sula/chave');
  // Toca na ponta da linha (no nome é link para a página do time)
  const row = (await page.$('#lib-bracket .tt[data-tie]'))!;
  await row.click({ offset: { x: 4, y: 8 } });
  await page.waitForSelector('#lib-bracket .tt.escolhido');
  await page.waitForSelector('#cup-picks-clear');
  await page.click('#cup-picks-clear');
  await page.waitForFunction(() => !document.querySelector('#lib-bracket .tt.escolhido'));

  // Agenda: atalho "Amanhã" só mostra jogos de amanhã
  await visit(page, '#/agenda');
  await page.click('#agenda-quando button[data-v="amanha"]');
  // Espera a lista se redesenhar (o botão acende antes de os dados chegarem)
  await page
    .waitForFunction(() => [...document.querySelectorAll('.agenda-dia')].every((h) => h.textContent!.startsWith('Amanhã')), { timeout: 15_000 })
    .catch(() => {});
  const days = await page.$$eval('.agenda-dia', (h) => h.map((x) => x.textContent));
  assert.ok(days.every((d) => d!.startsWith('Amanhã')), `dias na agenda: ${days.join(', ')}`);
  await page.click('#agenda-quando button[data-v="7"]');

  // Tema: automático → claro → escuro → automático
  const themes: (string | null)[] = [];
  for (let i = 0; i < 3; i++) {
    await page.click('#tema');
    themes.push(await page.evaluate(() => document.documentElement.dataset.theme ?? null));
  }
  assert.deepEqual(themes, ['light', 'dark', null]);

  // Jogo do topo: a seta escolhe outro jogo e fixa; "automático" volta ao normal
  await visit(page, '#/tabela');
  await page.click('.destaque-escolha .seta[data-hero="1"]');
  await page.waitForFunction(() => document.querySelector('#destaque')!.textContent!.includes('Escolhido por você'));
  await page.click('#destaque [data-hero="auto"]');
  await page.waitForFunction(() => !document.querySelector('#destaque')!.textContent!.includes('Escolhido por você'));

  // Celular: chavinha da tabela troca as colunas ("Chances" mostra título, vaga e queda)
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await visit(page, '#/tabela');
  const colunas = () => page.$$eval('#tabela .standings thead th', (ths) => ths.filter((t) => getComputedStyle(t).display !== 'none').map((t) => t.textContent!.trim()));
  await page.click('#tabela .vista-tabela [data-vista="chances"]');
  assert.ok((await colunas()).includes('Título'), 'visão Chances mostra o título');
  await page.click('#tabela .vista-tabela [data-vista="tabela"]');
  assert.ok(!(await colunas()).includes('Título'), 'visão Tabela esconde as chances');
  await page.setViewport({ width: 1366, height: 900 });

  // Sino abre a caixa de alertas
  await page.click('#bell');
  assert.ok(await page.$eval('#alert-dialog', (d) => (d as HTMLDialogElement).open));
  await page.$eval('#alert-dialog', (d) => (d as HTMLDialogElement).close());

  // Cartão de campeonato troca tudo
  await page.click('.comp-card[data-comp="serieb"]');
  await page.waitForFunction(() => document.body.dataset.comp === 'serieb' && document.querySelector('#brand-nome')!.textContent === 'Série B');

  await page.close();
  assert.deepEqual(errors, []);
});

test('trocar de tela com a internet lenta não deixa erro para trás', async () => {
  const { page, errors } = await openPanel(390, 844);
  // Sem o service worker no meio, para segurar um pedido específico
  await page.setBypassServiceWorker(true);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    // Internet lenta só na artilharia da Sul-Americana
    if (req.url().includes('/api/sula/scorers')) setTimeout(() => req.continue(), 3000);
    else req.continue();
  });
  // Abre a artilharia e, antes de ela chegar, já troca para a Série B
  await page.evaluate(() => (location.hash = '#/sula/gols'));
  await new Promise((r) => setTimeout(r, 300));
  const r = await visit(page, '#/serieb/tabela');
  // Espera a carga atrasada terminar (é ela que quebrava)
  await new Promise((r) => setTimeout(r, 4000));
  const banner = await page.$eval('#banner', (b) => ((b as HTMLElement).hidden ? null : b.textContent));
  const meta = await page.$eval('#meta', (m) => m.textContent);
  await page.close();
  assert.equal(r.banner, null);
  assert.equal(banner, null, 'aviso de erro depois da carga atrasada');
  assert.match(meta!, /^Série B/, 'a linha do topo continua sendo da Série B');
  assert.deepEqual(errors, []);
});
