// Cloudflare Worker: общий лидерборд игры "Денис Михалыч".
//
// Привязки окружения (см. wrangler.toml / wrangler secret):
//   KV        — KV namespace, хранит ключ "top" с топ-100 как JSON.
//   BOT_TOKEN — секрет, токен бота Telegram для валидации initData.
//
// Эндпоинты:
//   POST /score  { initData, score }  — валидирует подпись, обновляет личный
//                                        максимум игрока, возвращает место.
//   GET  /top    [?initData=...]       — топ-10; если передан initData,
//                                        дополнительно возвращает rank/best.

const TOP_KEY = 'top';
const MAX_KEEP = 100;          // сколько записей храним в KV
const MAX_AGE = 24 * 60 * 60;  // initData не старше суток (анти-реплей)

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

// Проверяет подпись initData по схеме Telegram WebApp.
// Возвращает { id, name } при успехе либо null.
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
    return { id: String(u.id), name: String(u.first_name || 'Игрок').slice(0, 24) };
  } catch {
    return null;
  }
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/top') {
      const top = JSON.parse((await env.KV.get(TOP_KEY)) || '[]');
      let rank = null, best = null;
      const initData = url.searchParams.get('initData');
      if (initData) {
        const user = await verifyInitData(initData, env.BOT_TOKEN);
        if (user) {
          const idx = top.findIndex((e) => e.id === user.id);
          if (idx >= 0) { rank = idx + 1; best = top[idx].s; }
        }
      }
      // id игроков наружу не отдаём
      const list = top.slice(0, 10).map(({ n, s }) => ({ n, s }));
      return json({ top: list, rank, best });
    }

    if (req.method === 'POST' && url.pathname === '/score') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }

      const user = await verifyInitData(body.initData, env.BOT_TOKEN);
      if (!user) return json({ error: 'unauthorized' }, 401);

      const score = Math.max(0, Math.floor(Number(body.score) || 0));
      const top = JSON.parse((await env.KV.get(TOP_KEY)) || '[]');
      const idx = top.findIndex((e) => e.id === user.id);
      if (idx >= 0) {
        top[idx].n = user.name;
        if (score > top[idx].s) { top[idx].s = score; top[idx].d = Date.now(); }
      } else {
        top.push({ id: user.id, n: user.name, s: score, d: Date.now() });
      }
      top.sort((a, b) => b.s - a.s);
      const trimmed = top.slice(0, MAX_KEEP);
      await env.KV.put(TOP_KEY, JSON.stringify(trimmed));

      const myIdx = trimmed.findIndex((e) => e.id === user.id);
      return json({
        ok: true,
        rank: myIdx >= 0 ? myIdx + 1 : null,
        best: myIdx >= 0 ? trimmed[myIdx].s : score,
      });
    }

    return json({ error: 'not found' }, 404);
  },
};
