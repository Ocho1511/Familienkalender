// Familienkalender Worker (Cloudflare Workers + KV)
// Alle Aufrufe: POST /  mit JSON { pass, op, ... }
//   op "pull"                       -> { members, events }
//   op "put", kind, item            -> legt an / ersetzt (kind: "member" | "event", item.id)
//   op "del", kind, id              -> loescht
// Das Familien-Passwort steckt als Secret FAMILY_PASSWORD im Worker (wrangler secret put).
// Gespeichert wird alles in einem KV-Eintrag "state".

const DEFAULT_ORIGINS = ['https://ocho1511.github.io'];
const MAX_EVENTS = 5000;
const MAX_MEMBERS = 30;
const ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
const CATS = ['Aktivität', 'Klassenarbeit', 'Urlaub', 'Arzt', 'Geburtstag', 'Termin', 'Sonstiges'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function origins(env) {
  return env.ALLOWED_ORIGINS ? String(env.ALLOWED_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_ORIGINS;
}
function cors(request, env) {
  const o = request.headers.get('Origin') || '';
  const ok = origins(env).includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return {
    'Access-Control-Allow-Origin': ok ? o : origins(env)[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
function reply(obj, status, c) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', ...c } });
}
const str = (v, max) => String(v == null ? '' : v).slice(0, max);

async function sameText(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

// Falsche Passwoerter pro IP begrenzen (10 pro Stunde)
async function failCount(env, ip) {
  return parseInt((await env.KV.get('fail:' + ip)) || '0', 10) || 0;
}
async function addFail(env, ip) {
  const n = (await failCount(env, ip)) + 1;
  await env.KV.put('fail:' + ip, String(n), { expirationTtl: 3600 });
}

function cleanMember(m) {
  if (!m || !ID_RE.test(m.id || '')) return null;
  const name = str(m.name, 40).trim();
  if (!name) return null;
  return { id: m.id, name, color: COLOR_RE.test(m.color || '') ? m.color : '#7d8a82', createdAt: Number(m.createdAt) || Date.now() };
}
function cleanEvent(e) {
  if (!e || !ID_RE.test(e.id || '')) return null;
  const title = str(e.title, 120).trim();
  if (!title || !DATE_RE.test(e.start || '')) return null;
  const end = DATE_RE.test(e.end || '') && e.end >= e.start ? e.end : '';
  return {
    id: e.id, title, who: ID_RE.test(e.who || '') ? e.who : '',
    cat: CATS.includes(e.cat) ? e.cat : 'Termin',
    start: e.start, end, time: TIME_RE.test(e.time || '') ? e.time : '',
    note: str(e.note, 500).trim(), createdAt: Number(e.createdAt) || Date.now(),
  };
}

export default {
  async fetch(request, env) {
    const c = cors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: c });
    if (request.method !== 'POST') return reply({ error: 'POST erwartet' }, 405, c);
    if (!env.KV || !env.FAMILY_PASSWORD) return reply({ error: 'Worker nicht eingerichtet' }, 500, c);

    let body;
    try { body = await request.json(); } catch (e) { return reply({ error: 'Ungueltige Anfrage' }, 400, c); }

    const ip = request.headers.get('CF-Connecting-IP') || 'anon';
    if ((await failCount(env, ip)) >= 10) return reply({ error: 'Zu viele Versuche. Bitte spaeter erneut.' }, 429, c);
    if (!(await sameText(str(body.pass, 200).trim(),String(env.FAMILY_PASSWORD).trim()))) {
      await addFail(env, ip);
      return reply({ error: 'Falsches Passwort' }, 401, c);
    }

    let state = (await env.KV.get('state', 'json')) || { members: [], events: [] };
    state.members = state.members || [];
    state.events = state.events || [];

    if (body.op === 'pull') return reply({ members: state.members, events: state.events }, 200, c);

    if (body.op === 'put' || body.op === 'del') {
      const isMember = body.kind === 'member';
      if (!isMember && body.kind !== 'event') return reply({ error: 'kind?' }, 400, c);
      const list = isMember ? state.members : state.events;
      if (body.op === 'put') {
        const item = isMember ? cleanMember(body.item) : cleanEvent(body.item);
        if (!item) return reply({ error: 'Ungueltige Daten' }, 400, c);
        const i = list.findIndex((x) => x.id === item.id);
        if (i >= 0) list[i] = item;
        else {
          if (list.length >= (isMember ? MAX_MEMBERS : MAX_EVENTS)) return reply({ error: 'Limit erreicht' }, 413, c);
          list.push(item);
        }
      } else {
        const i = list.findIndex((x) => x.id === body.id);
        if (i >= 0) list.splice(i, 1);
      }
      await env.KV.put('state', JSON.stringify(state));
      return reply({ members: state.members, events: state.events }, 200, c);
    }
    return reply({ error: 'op?' }, 400, c);
  },
};
