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
  return { id: m.id, name, color: COLOR_RE.test(m.color || '') ? m.color : '#7d8a82', createdAt: Number(m.createdAt) || Date.now(), order: Number.isFinite(Number(m.order)) && m.order !== undefined && m.order !== null ? Number(m.order) : undefined };
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

// ---- Outlook-Abo (iCalendar-Feed, nur lesend) ----
function icsEsc(t) {
  return String(t || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function icsFold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 74) return line;
  const out = [];
  let cur = '';
  for (const ch of line) {
    const limit = out.length === 0 ? 74 : 73;
    if (enc.encode(cur + ch).length > limit) { out.push(cur); cur = ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}
const d8 = (s) => s.replace(/-/g, '');
function nextDay(s) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function buildIcs(state) {
  const names = {};
  (state.members || []).forEach((m) => { names[m.id] = m.name; });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Familienkalender//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Familienkalender', 'X-PUBLISHED-TTL:PT1H', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H'];
  (state.events || []).forEach((e) => {
    const who = e.who && names[e.who] ? names[e.who] : 'Alle';
    const end = e.end && e.end >= e.start ? e.end : e.start;
    L.push('BEGIN:VEVENT', 'UID:' + e.id + '@familienkalender', 'DTSTAMP:' + stamp);
    if (e.time) {
      const t = e.time.replace(':', '') + '00';
      const [h, m] = e.time.split(':').map(Number);
      const endT = e.end && e.end > e.start ? e.time.replace(':', '') + '00' : String((h + 1) % 24).padStart(2, '0') + String(m).padStart(2, '0') + '00';
      const endDate = e.end && e.end > e.start ? e.end : (h + 1 >= 24 ? nextDay(e.start) : e.start);
      L.push('DTSTART:' + d8(e.start) + 'T' + t, 'DTEND:' + d8(endDate) + 'T' + endT);
    } else {
      L.push('DTSTART;VALUE=DATE:' + d8(e.start), 'DTEND;VALUE=DATE:' + d8(nextDay(end)));
    }
    L.push('SUMMARY:' + icsEsc(who + ': ' + e.title), 'CATEGORIES:' + icsEsc(e.cat || 'Termin'));
    if (e.note) L.push('DESCRIPTION:' + icsEsc(e.note));
    L.push('END:VEVENT');
  });
  L.push('END:VCALENDAR');
  return L.map(icsFold).join('\r\n') + '\r\n';
}

export default {
  async fetch(request, env) {
    const c = cors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: c });

    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/ics') {
      const ip0 = request.headers.get('CF-Connecting-IP') || 'anon';
      if (!env.KV || !env.ICS_TOKEN) return new Response('nicht eingerichtet', { status: 500 });
      if ((await failCount(env, ip0)) >= 10) return new Response('zu viele Versuche', { status: 429 });
      if (!(await sameText(url.searchParams.get('t') || '', String(env.ICS_TOKEN).trim()))) {
        await addFail(env, ip0);
        return new Response('nicht gefunden', { status: 404 });
      }
      const st = (await env.KV.get('state', 'json')) || { members: [], events: [] };
      return new Response(buildIcs(st), { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=300' } });
    }
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

    if (body.op === 'ics') {
      if (!env.ICS_TOKEN) return reply({ error: 'Outlook-Link nicht eingerichtet' }, 500, c);
      return reply({ url: url.origin + '/ics?t=' + String(env.ICS_TOKEN).trim() }, 200, c);
    }
    if (body.op === 'reorder') {
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      state.members.forEach((m) => { const i = ids.indexOf(m.id); if (i >= 0) m.order = i; });
      await env.KV.put('state', JSON.stringify(state));
      return reply({ members: state.members, events: state.events }, 200, c);
    }
    if (body.op === 'photo_get') {
      return reply({ photo: (await env.KV.get('photo')) || null }, 200, c);
    }
    if (body.op === 'photo_put') {
      const d = String(body.data || '');
      if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(d) || d.length > 1500000) return reply({ error: 'Bild ungueltig oder zu gross' }, 400, c);
      await env.KV.put('photo', d);
      return reply({ photo: d }, 200, c);
    }
    // Loeschen nur mit separatem Loeschkennwort (ADMIN_PASSWORD), nicht mit dem Login-Passwort
    if (body.op === 'photo_del' || body.op === 'del') {
      if (!env.ADMIN_PASSWORD) return reply({ error: 'Loeschkennwort nicht eingerichtet' }, 500, c);
      if (!(await sameText(str(body.admin, 200).trim(), String(env.ADMIN_PASSWORD).trim()))) {
        await addFail(env, ip);
        return reply({ error: 'Falsches Loeschkennwort' }, 403, c);
      }
    }
    if (body.op === 'photo_del') {
      await env.KV.delete('photo');
      return reply({ photo: null }, 200, c);
    }
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
