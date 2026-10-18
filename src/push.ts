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
  /** Lembrete 30 minutos antes do jogo */
  reminder: boolean;
  /** No fim do jogo do Brasileirão, como ficaram as chances */
  summary: boolean;
  /** Quando a chance de um time seguido muda muito depois de uma rodada */
  changes: boolean;
}

/** Tipo de aviso: gol sempre vai; os outros, só para quem pediu */
export type PushKind = 'goal' | 'kickoff' | 'fulltime' | 'reminder' | 'summary' | 'change';

function wants(p: Prefs, kind: PushKind): boolean {
  if (kind === 'goal') return true;
  if (kind === 'kickoff' || kind === 'fulltime') return p.kickoff;
  if (kind === 'reminder') return p.reminder;
  if (kind === 'summary') return p.summary;
  return p.changes;
}

export interface PushMessage {
  title: string;
  body: string;
  icon?: string;
  tag: string;
  url: string;
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
    // Contato do painel para os serviços de push: o informado, ou o endereço que o Render dá sozinho
    const subject = process.env.VAPID_SUBJECT || process.env.RENDER_EXTERNAL_URL || 'mailto:painel@example.com';
    webpush.setVapidDetails(subject, keys!.publicKey, keys!.privateKey);
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

const follows = (p: Prefs, teamIds: number[]) => p.all || teamIds.some((id) => p.teams.includes(id));

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
 * Manda uma notificação para quem segue algum dos times (e pediu esse tipo de aviso).
 * `skip` tira alguém da lista (ex.: quem já vai receber o resumo do jogo). `send` só muda nos testes.
 */
export async function pushMessage(
  teamIds: number[],
  kind: PushKind,
  msg: PushMessage,
  { send = webpush.sendNotification as Send, skip }: { send?: Send; skip?: (p: Prefs) => boolean } = {},
): Promise<void> {
  if (!subscribers.size) return;
  await setup();
  const payload = JSON.stringify(msg);
  const sends: Promise<unknown>[] = [];
  for (const [endpoint, s] of subscribers) {
    if (!wants(s.prefs, kind) || !follows(s.prefs, teamIds) || skip?.(s.prefs)) continue;
    sends.push(
      send(s.subscription, payload, { TTL: 600, urgency: kind === 'goal' ? 'high' : 'normal' }).catch((err: webpush.WebPushError) => {
        // 404/410: o aparelho cancelou a inscrição
        if (err.statusCode === 404 || err.statusCode === 410) {
          subscribers.delete(endpoint);
          save();
        } else console.warn('Push: falha ao enviar:', err.statusCode ?? '', err.message);
      }),
    );
  }
  await Promise.all(sends);
}

/**
 * Manda os eventos de um campeonato para quem segue. `jogoUrl` monta o link de
 * cada jogo. Com `withSummary`, quem pediu o resumo recebe ele no lugar do "Fim de jogo".
 */
export async function pushEvents(
  events: LiveEvent[],
  jogoUrl: (matchId: number) => string,
  { send, withSummary = false }: { send?: Send; withSummary?: boolean } = {},
): Promise<void> {
  for (const ev of events) {
    const skip = ev.type === 'fulltime' && withSummary ? (p: Prefs) => p.summary : undefined;
    await pushMessage([ev.home.id, ev.away.id], ev.type, message(ev, jogoUrl(ev.matchId)), { send, skip });
  }
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
      reminder: !!p.reminder,
      summary: !!p.summary,
      changes: !!p.changes,
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
