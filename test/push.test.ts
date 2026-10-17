import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import type { LiveEvent } from '../src/model/liveEvents.ts';
import { team } from './helpers.ts';

// Chaves e inscrições numa pasta temporária, longe das do painel
process.env.PUSH_DIR = mkdtempSync(path.join(tmpdir(), 'push-'));
const { push, pushEvents } = await import('../src/push.ts');

/** Inscrição como a que o navegador cria (chaves de verdade, para a criptografia funcionar) */
function subscription(endpoint: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint, keys: { p256dh: ecdh.getPublicKey('base64url'), auth: randomBytes(16).toString('base64url') } };
}

test('gol vai só para quem segue o time; início de jogo só para quem pediu', async () => {
  // Envio de mentira: guarda o que iria para cada aparelho
  const received = new Map<string, { title: string; url: string }[]>();
  const send = async (sub: { endpoint: string }, payload: string) => {
    received.set(sub.endpoint, [...(received.get(sub.endpoint) ?? []), JSON.parse(payload)]);
  };
  const app = express().use('/api/push', push);
  const api = app.listen(0);
  const base = `http://localhost:${(api.address() as AddressInfo).port}/api/push`;
  const subscribe = (name: string, prefs: object) =>
    fetch(`${base}/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: subscription(`https://push.example/${name}`), prefs }) });
  try {
    assert.equal((await fetch(`${base}/key`).then((r) => r.json())).publicKey.length > 40, true);
    assert.equal((await subscribe('torcedor-1', { all: false, teams: [1], kickoff: false })).status, 200);
    assert.equal((await subscribe('torcedor-3', { all: false, teams: [3], kickoff: false })).status, 200);
    assert.equal((await subscribe('todos', { all: true, teams: [], kickoff: true })).status, 200);
    const bad = await fetch(`${base}/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"subscription":{}}' });
    assert.equal(bad.status, 400);

    const [a, b] = [team(1), team(2)];
    const events: LiveEvent[] = [
      { type: 'kickoff', matchId: 9, home: a, away: b },
      { type: 'goal', matchId: 9, side: 'home', home: a, away: b, homeGoals: 1, awayGoals: 0, minute: 12 },
    ];
    await pushEvents(events, (id) => `/#/jogo/${id}`, { send });
    const got = (name: string) => received.get(`https://push.example/${name}`) ?? [];
    assert.deepEqual(got('torcedor-1').map((m) => m.title), [`GOL do ${a.shortName}!`], 'só o gol (não pediu início de jogo)');
    assert.equal(got('torcedor-1')[0].url, '/#/jogo/9');
    assert.equal(got('torcedor-3').length, 0, 'não segue nenhum dos dois times');
    assert.deepEqual(got('todos').map((m) => m.title), ['Começou!', `GOL do ${a.shortName}!`]);
  } finally {
    api.close();
  }
});

test('mensagem sai criptografada e assinada com as chaves do painel', async () => {
  const { default: webpush } = await import('web-push');
  // Garante que as chaves foram carregadas (o /key faz isso)
  const app = express().use('/api/push', push);
  const api = app.listen(0);
  try {
    await fetch(`http://localhost:${(api.address() as AddressInfo).port}/api/push/key`);
    const req = webpush.generateRequestDetails(subscription('https://push.example/x'), JSON.stringify({ title: 'GOL' }));
    assert.equal(req.headers['Content-Encoding'], 'aes128gcm');
    assert.match(String(req.headers.Authorization), /^vapid t=/);
    assert.ok((req.body as Buffer).length > 0);
  } finally {
    api.close();
  }
});

test('lembrete e resumo vão só para quem pediu; quem pediu resumo não recebe o "Fim de jogo" simples', async () => {
  const { pushMessage } = await import('../src/push.ts');
  const app = express().use('/api/push', push);
  const api = app.listen(0);
  const base = `http://localhost:${(api.address() as AddressInfo).port}/api/push`;
  const subscribe = (name: string, prefs: object) =>
    fetch(`${base}/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: subscription(`https://push.example/k-${name}`), prefs }) });
  const received = new Map<string, string[]>();
  const send = async (sub: { endpoint: string }, payload: string) => {
    received.set(sub.endpoint, [...(received.get(sub.endpoint) ?? []), JSON.parse(payload).title]);
  };
  const got = (name: string) => received.get(`https://push.example/k-${name}`) ?? [];
  try {
    await subscribe('lembrete', { teams: [7], reminder: true });
    await subscribe('resumo', { teams: [7], kickoff: true, summary: true });
    await subscribe('simples', { teams: [7], kickoff: true });
    await pushMessage([7, 8], 'reminder', { title: 'Daqui a pouco', body: '', tag: 'x', url: '/' }, { send });
    const [a, b] = [team(7), team(8)];
    await pushEvents([{ type: 'fulltime', matchId: 1, home: a, away: b, homeGoals: 2, awayGoals: 1 }], () => '/', { send, withSummary: true });
    await pushMessage([7, 8], 'summary', { title: 'Resumo', body: '', tag: 'x', url: '/' }, { send });
    assert.deepEqual(got('lembrete'), ['Daqui a pouco']);
    assert.deepEqual(got('resumo'), ['Resumo']);
    assert.deepEqual(got('simples'), ['Fim de jogo']);
  } finally {
    api.close();
  }
});
