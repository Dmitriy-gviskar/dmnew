// Cloudflare Worker: бэкенд игры "Денис Михалыч" — лидерборд + рефералы.
//
// Привязки окружения (см. wrangler.toml / wrangler secret):
//   KV        — KV namespace. Ключи:
//                 top                — топ за всё время
//                 top:<ISO-неделя>   — недельный топ (TTL 60 дней)
//                 ref:<userId>       — кем приглашён игрок (одноразово)
//                 pending:<userId>   — монеты к зачислению при следующем заходе
//                 refstats:<userId>  — { invites }
//                 botusername        — кэш имени бота (TTL сутки)
//   BOT_TOKEN — секрет, токен бота Telegram для валидации initData и getMe.
//
// Эндпоинты:
//   POST /score  { initData, score }   — обновляет максимум (всё время + неделя)
//   GET  /top    [?period=week|all]    — топ-10 (+ rank/best при initData)
//   POST /ref    { initData }          — атрибуция реферала по start_param
//   POST /claim  { initData }          — забрать накопленные бонусные монеты
//   GET  /bot                          — { username } бота для реф-ссылок

const TOP_KEY = 'top';
const MAX_KEEP = 100;
const MAX_AGE = 24 * 60 * 60;
const WEEK_TTL = 60 * 24 * 60 * 60;
const REF_REWARD = 100;   // монет пригласившему за каждого друга
const INVITE_BONUS = 50;  // монет новому игроку за вход по ссылке

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const enc = new TextEncoder();

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function hmac(keyBytes, msg) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

function toHex(buf) {
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isoWeekId(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Проверяет подпись initData (Telegram WebApp).
// Возвращает { id, name, startParam } при успехе либо null.
async function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dcs = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secret = await hmac(enc.encode('WebAppData'), botToken);
  const computed = toHex(await hmac(secret, dcs));
  if (computed !== hash) return null;

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE) return null;

  try {
    const u = JSON.parse(params.get('user') || 'null');
    if (!u || !u.id) return null;
    return {
      id: String(u.id),
      name: String(u.first_name || 'Игрок').slice(0, 24),
      startParam: params.get('start_param') || '',
    };
  } catch {
    return null;
  }
}

async function upsertTop(env, key, user, score, ttl) {
  const top = JSON.parse((await env.KV.get(key)) || '[]');
  const idx = top.findIndex((e) => e.id === user.id);
  if (idx >= 0) {
    top[idx].n = user.name;
    if (score > top[idx].s) { top[idx].s = score; top[idx].d = Date.now(); }
  } else {
    top.push({ id: user.id, n: user.name, s: score, d: Date.now() });
  }
  top.sort((a, b) => b.s - a.s);
  const trimmed = top.slice(0, MAX_KEEP);
  await env.KV.put(key, JSON.stringify(trimmed), ttl ? { expirationTtl: ttl } : undefined);
  return trimmed;
}

async function addPending(env, id, amount) {
  const k = `pending:${id}`;
  const cur = parseInt((await env.KV.get(k)) || '0', 10) || 0;
  await env.KV.put(k, String(cur + amount));
}

async function bumpInvites(env, id) {
  const k = `refstats:${id}`;
  const s = JSON.parse((await env.KV.get(k)) || '{}');
  s.invites = (s.invites || 0) + 1;
  await env.KV.put(k, JSON.stringify(s));
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/top') {
      const period = url.searchParams.get('period') === 'week' ? 'week' : 'all';
      const key = period === 'week' ? `${TOP_KEY}:${isoWeekId(new Date())}` : TOP_KEY;
      const top = JSON.parse((await env.KV.get(key)) || '[]');

      let rank = null, best = null;
      const initData = url.searchParams.get('initData');
      if (initData) {
        const user = await verifyInitData(initData, env.BOT_TOKEN);
        if (user) {
          const idx = top.findIndex((e) => e.id === user.id);
          if (idx >= 0) { rank = idx + 1; best = top[idx].s; }
        }
      }
      const list = top.slice(0, 10).map(({ n, s }) => ({ n, s }));
      return json({ top: list, rank, best, period });
    }

    if (req.method === 'POST' && url.pathname === '/score') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      const user = await verifyInitData(body.initData, env.BOT_TOKEN);
      if (!user) return json({ error: 'unauthorized' }, 401);

      const score = Math.max(0, Math.floor(Number(body.score) || 0));
      const weekKey = `${TOP_KEY}:${isoWeekId(new Date())}`;
      const all = await upsertTop(env, TOP_KEY, user, score, 0);
      await upsertTop(env, weekKey, user, score, WEEK_TTL);

      const myIdx = all.findIndex((e) => e.id === user.id);
      return json({
        ok: true,
        rank: myIdx >= 0 ? myIdx + 1 : null,
        best: myIdx >= 0 ? all[myIdx].s : score,
      });
    }

    if (req.method === 'POST' && url.pathname === '/ref') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      const user = await verifyInitData(body.initData, env.BOT_TOKEN);
      if (!user) return json({ error: 'unauthorized' }, 401);

      const m = /^ref(\d+)$/.exec(user.startParam || '');
      if (!m) return json({ ok: false, reason: 'no_ref' });
      const refId = m[1];
      if (refId === user.id) return json({ ok: false, reason: 'self' });
      if (await env.KV.get(`ref:${user.id}`)) return json({ ok: false, reason: 'already' });

      await env.KV.put(`ref:${user.id}`, refId);
      await addPending(env, refId, REF_REWARD);
      await addPending(env, user.id, INVITE_BONUS);
      await bumpInvites(env, refId);
      return json({ ok: true, bonus: INVITE_BONUS });
    }

    if (req.method === 'POST' && url.pathname === '/claim') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      const user = await verifyInitData(body.initData, env.BOT_TOKEN);
      if (!user) return json({ error: 'unauthorized' }, 401);

      const k = `pending:${user.id}`;
      const claimed = parseInt((await env.KV.get(k)) || '0', 10) || 0;
      if (claimed > 0) await env.KV.put(k, '0');
      const stats = JSON.parse((await env.KV.get(`refstats:${user.id}`)) || '{}');
      return json({ ok: true, claimed, invites: stats.invites || 0 });
    }

    if (req.method === 'GET' && url.pathname === '/bot') {
      let u = await env.KV.get('botusername');
      if (!u) {
        try {
          const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`);
          const d = await r.json();
          u = d && d.result && d.result.username ? d.result.username : '';
          if (u) await env.KV.put('botusername', u, { expirationTtl: 86400 });
        } catch { u = ''; }
      }
      return json({ username: u });
    }

    return json({ error: 'not found' }, 404);
  },
};
