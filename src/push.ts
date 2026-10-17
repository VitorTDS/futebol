// Notificações de gol com o celular bloqueado (Web Push). O navegador só entrega
// em site com HTTPS (ou localhost). Cada aparelho manda a sua inscrição e os times
// que segue; quando sai um gol, o servidor avisa só quem segue aquele jogo.
import express from 'express';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import webpush from 'web-push';
import type { LiveEvent } from './model/liveEvents.ts';

// PUSH_DIR: onde guardar chaves e inscrições (na hospedagem, um disco que não se apaga)
const DIR = process.env.PUSH_DIR || path.join(import.meta.dirname, '..', 'data', 'cache');
const KEYS_FILE = path.join(DIR, 'vapid.json');
const SUBS_FILE = path.join(DIR, 'push-inscricoes.json');

interface Prefs {
  /** Todos os jogos, ou só os dos times em `teams` */
  all: boolean;
  teams: number[];
  /** Também avisa início e fim de jogo */
  kickoff: boolean;
}

interface Subscriber {
  subscription: webpush.PushSubscription;
  prefs: Prefs;
  updatedAt: string;
}

const subscribers = new Map<string, Subscriber>();
let ready: Promise<{ publicKey: string }> | null = null;

/**
 * Chaves VAPID: na hospedagem vêm das variáveis VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY
 * (assim não mudam a cada reinício); no computador são criadas uma vez e guardadas
 * em data/cache/vapid.json.
 */
function setup(): Promise<{ publicKey: string }> {
  ready ??= (async () => {
    let keys = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
      ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
      : null;
    if (!keys) {
      try {
        keys = JSON.parse(await readFile(KEYS_FILE, 'utf8'));
      } catch {
        keys = webpush.generateVAPIDKeys();
        await mkdir(DIR, { recursive: true });
        await writeFile(KEYS_FILE, JSON.stringify(keys));
      }
    }
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:painel@example.com', keys!.publicKey, keys!.privateKey);
    try {
      for (const s of JSON.parse(await readFile(SUBS_FILE, 'utf8')) as Subscriber[]) subscribers.set(s.subscription.endpoint, s);
    } catch {
      // ainda sem inscrições
    }
    return { publicKey: keys!.publicKey };
  })();
  return ready;
}

let saving = Promise.resolve();
function save() {
  saving = saving.then(async () => {
    await mkdir(DIR, { recursive: true });
    await writeFile(SUBS_FILE, JSON.stringify([...subscribers.values()]));
  }).catch((err) => console.warn('Push: não foi possível salvar as inscrições:', err.message));
}

const follows = (p: Prefs, ev: LiveEvent) => p.all || p.teams.includes(ev.home.id) || p.teams.includes(ev.away.id);

/** Texto da notificação (o mesmo da página) */
function message(ev: LiveEvent, url: string) {
  const score = ev.type === 'kickoff' ? `${ev.home.shortName} 0 × 0 ${ev.away.shortName}` : `${ev.home.shortName} ${ev.homeGoals} × ${ev.awayGoals} ${ev.away.shortName}`;
  if (ev.type === 'goal') {
    const who = ev.side === 'home' ? ev.home : ev.away;
    return { title: `GOL do ${who.shortName}!`, body: `${score}${ev.minute ? ` · ${ev.minute}'` : ''}`, icon: who.crest, tag: `jogo-${ev.matchId}`, url };
  }
  return { title: ev.type === 'kickoff' ? 'Começou!' : 'Fim de jogo', body: score, icon: ev.home.crest, tag: `jogo-${ev.matchId}`, url };
}

type Send = (sub: webpush.PushSubscription, payload: string, options: webpush.RequestOptions) => Promise<unknown>;

/**
 * Manda os eventos de um campeonato para quem segue. `jogoUrl` monta o link de
 * cada jogo; `send` só muda nos testes.
 */
export async function pushEvents(events: LiveEvent[], jogoUrl: (matchId: number) => string, send: Send = webpush.sendNotification): Promise<void> {
  if (!events.length || !subscribers.size) return;
  await setup();
  const sends: Promise<unknown>[] = [];
  for (const ev of events) {
    const payload = JSON.stringify(message(ev, jogoUrl(ev.matchId)));
    for (const [endpoint, s] of subscribers) {
      if (ev.type !== 'goal' && !s.prefs.kickoff) continue;
      if (!follows(s.prefs, ev)) continue;
      sends.push(
        send(s.subscription, payload, { TTL: 600, urgency: 'high' }).catch((err: webpush.WebPushError) => {
          // 404/410: o aparelho cancelou a inscrição
          if (err.statusCode === 404 || err.statusCode === 410) {
            subscribers.delete(endpoint);
            save();
          } else console.warn('Push: falha ao enviar:', err.statusCode ?? '', err.message);
        }),
      );
    }
  }
  await Promise.all(sends);
}

export const push = express.Router();
push.use(express.json({ limit: '8kb' }));

push.get('/key', async (_req, res, next) => {
  try {
    res.json({ publicKey: (await setup()).publicKey });
  } catch (err) {
    next(err);
  }
});

push.post('/subscribe', async (req, res, next) => {
  try {
    await setup();
    const sub = req.body?.subscription as webpush.PushSubscription | undefined;
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      res.status(400).json({ error: 'Inscrição inválida' });
      return;
    }
    const p = req.body?.prefs ?? {};
    const prefs: Prefs = {
      all: !!p.all,
      teams: Array.isArray(p.teams) ? p.teams.map(Number).filter(Number.isFinite).slice(0, 100) : [],
      kickoff: !!p.kickoff,
    };
    subscribers.set(sub.endpoint, { subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, prefs, updatedAt: new Date().toISOString() });
    save();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

push.post('/unsubscribe', async (req, res) => {
  await setup();
  if (subscribers.delete(String(req.body?.endpoint ?? ''))) save();
  res.json({ ok: true });
});
