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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

const REMINDS = [0, 15, 30, 60, 120, 1440, 2880];
const REPEATS = ['d', 'w', '2w', 'm', 'y'];
function cleanMember(m) {
  if (!m || !ID_RE.test(m.id || '')) return null;
  const name = str(m.name, 40).trim();
  if (!name) return null;
  const email = str(m.email, 80).trim();
  const handle = (v) => str(v, 40).replace(/^@/, '').replace(/[^A-Za-z0-9._]/g, '');
  const phoneClean = (v) => str(v, 30).replace(/[^0-9+()\/\s.-]/g, '').trim();
  return {
    id: m.id, name, color: COLOR_RE.test(m.color || '') ? m.color : '#7d8a82', createdAt: Number(m.createdAt) || Date.now(),
    order: Number.isFinite(Number(m.order)) && m.order !== undefined && m.order !== null ? Number(m.order) : undefined,
    phone: phoneClean(m.phone),
    whatsapp: phoneClean(m.whatsapp),
    tiktok: handle(m.tiktok),
    instagram: handle(m.instagram),
    snapchat: handle(m.snapchat),
    telegram: handle(m.telegram),
    discord: handle(m.discord),
    birthday: DATE_RE.test(m.birthday || '') ? m.birthday : '',
    email: /^[^\s@]+@[^\s@]+$/.test(email) ? email : '',
    note: str(m.note, 300).trim(),
  };
}
function cleanEvent(e) {
  if (!e || !ID_RE.test(e.id || '')) return null;
  const title = str(e.title, 120).trim();
  if (!title || !DATE_RE.test(e.start || '')) return null;
  const repeat = REPEATS.includes(e.repeat) ? e.repeat : undefined;
  const end = !repeat && DATE_RE.test(e.end || '') && e.end >= e.start ? e.end : '';
  const until = repeat && DATE_RE.test(e.until || '') && e.until >= e.start ? e.until : undefined;
  const hasRemind = e.remind !== null && e.remind !== undefined && e.remind !== '' && REMINDS.includes(Number(e.remind));
  return {
    id: e.id, title, who: ID_RE.test(e.who || '') ? e.who : '',
    cat: CATS.includes(e.cat) ? e.cat : 'Termin',
    start: e.start, end, time: TIME_RE.test(e.time || '') ? e.time : '',
    note: str(e.note, 500).trim(), createdAt: Number(e.createdAt) || Date.now(),
    remind: hasRemind ? Number(e.remind) : undefined,
    remindWa: hasRemind && (e.remindWa === true || e.remindWa === 'true') ? true : undefined,
    remindSms: hasRemind && e.remindSms === true ? true : undefined,
    remindMail: hasRemind && e.remindMail === true ? true : undefined,
    remindCall: hasRemind && e.remindCall === true ? true : undefined,
    repeat, until,
    skip: repeat && Array.isArray(e.skip) ? (() => { const a = [...new Set(e.skip.filter((x) => DATE_RE.test(x || '')))].sort().slice(0, 100); return a.length ? a : undefined; })() : undefined,
    place: str(e.place, 80).replace(/[\r\n\t]+/g, ' ').trim() || undefined,
  };
}

// ---- Push-Erinnerungen: Web Push ohne Nutzlast, die Meldung holt der Service Worker unter /pending ab ----
function b64u(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let t = '';
  bytes.forEach((x) => { t += String.fromCharCode(x); });
  return btoa(t).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256hex(t) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
// "2026-11-20" + "09:00" (deutsche Ortszeit) -> Millisekunden UTC
function berlinToUtc(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const offsetAt = (ts) => {
    const o = {};
    fmt.formatToParts(new Date(ts)).forEach((p) => { o[p.type] = p.value; });
    return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second) - ts;
  };
  let ts = guess - offsetAt(guess);
  ts = guess - offsetAt(ts);
  return ts;
}
async function vapidAuth(env, endpoint) {
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://ocho1511.github.io/Familienkalender/' };
  const input = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })) + '.' + b64u(JSON.stringify(claims));
  const key = await crypto.subtle.importKey('jwk', JSON.parse(String(env.VAPID_PRIVATE).slice(String(env.VAPID_PRIVATE).indexOf('{'))), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input));
  return 'vapid t=' + input + '.' + b64u(sig) + ', k=' + env.VAPID_PUBLIC;
}
async function sendPush(env, hash, endpoint, messages) {
  if (messages && messages.length) {
    const key = 'pend:' + hash;
    const cur = (await env.KV.get(key, 'json')) || [];
    await env.KV.put(key, JSON.stringify(cur.concat(messages).slice(-8)), { expirationTtl: 3600 });
  }
  const r = await fetch(endpoint, { method: 'POST', headers: { TTL: '3600', Urgency: 'high', Authorization: await vapidAuth(env, endpoint) } });
  return r.status;
}
function leadText(min) {
  if (min === 0) return 'jetzt';
  if (min < 60) return 'in ' + min + ' Min.';
  if (min < 1440) return 'in ' + min / 60 + ' Std.';
  return 'in ' + min / 1440 + (min >= 2880 ? ' Tagen' : ' Tag');
}
// ---- WhatsApp (offizielle Cloud API von Meta, Vorlagen-Nachricht) ----
function waConfigured(env) { return !!(env.WA_TOKEN && env.WA_PHONE_ID && env.WA_TEMPLATE); }
// "0170 123" -> "49170123", "+49 170 123" -> "49170123"
function waNumber(num) {
  let n = String(num || '').trim();
  const plus = n.startsWith('+');
  n = n.replace(/[^0-9]/g, '');
  if (!n) return '';
  if (plus) return n;
  if (n.startsWith('00')) return n.slice(2);
  if (n.startsWith('0')) return '49' + n.slice(1);
  return n;
}
const waText = (t) => String(t == null ? '' : t).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 200) || '-';
async function waSend(env, to, params) {
  const r = await fetch('https://graph.facebook.com/v21.0/' + encodeURIComponent(env.WA_PHONE_ID) + '/messages', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + String(env.WA_TOKEN).trim(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to, type: 'template',
      template: { name: env.WA_TEMPLATE, language: { code: env.WA_LANG || 'de' }, components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: waText(p) })) }] },
    }),
  });
  let detail = '';
  try { const j = await r.json(); detail = (j && j.error && j.error.message) || ''; } catch (e) { /* kein JSON */ }
  return { ok: r.ok, status: r.status, detail };
}
// Termine einer Wiederholung zwischen zwei Tagen (ISO, inklusive)
function occDates(e, from, to) {
  const out = [];
  const a = new Date(e.start + 'T00:00:00Z');
  let d = new Date((from > e.start ? from : e.start) + 'T00:00:00Z');
  const end = new Date(((e.until && e.until < to) ? e.until : to) + 'T00:00:00Z');
  for (; d <= end; d = new Date(d.getTime() + 86400000)) {
    const days = Math.round((d - a) / 86400000);
    const ok = days >= 0 && (e.repeat === 'd' || (e.repeat === 'w' && days % 7 === 0) || (e.repeat === '2w' && days % 14 === 0) ||
      (e.repeat === 'm' && d.getUTCDate() === a.getUTCDate()) ||
      (e.repeat === 'y' && d.getUTCDate() === a.getUTCDate() && d.getUTCMonth() === a.getUTCMonth()));
    const day = d.toISOString().slice(0, 10);
    if (ok && !(e.skip && e.skip.includes(day))) out.push(day);
  }
  return out;
}
// ---- Weitere Kanaele: SMS und Anruf mit Sprachnachricht (Twilio), E-Mail (Brevo) ----
const smsConfigured = (env) => !!(env.TWILIO_SID && env.TWILIO_TOKEN && env.TWILIO_FROM);
const mailConfigured = (env) => !!(env.BREVO_KEY && env.MAIL_FROM);
const DEFAULT_TEXTS = {
  smsText: 'Erinnerung Familienkalender: {titel}, {datum} {zeit}{ort} ({wer}, {vorlauf})',
  voiceText: 'Hallo {name}. Erinnerung vom Familienkalender. {titel}, am {datum}, {zeit}. {vorlauf}.',
  mailSubject: 'Erinnerung: {titel} am {datum}',
  mailText: 'Hallo {name},\n\nzur Erinnerung: {titel}\nWann: {datum}, {zeit}\nWo: {ortText}\nFür: {wer}\n\nDein Familienkalender',
};
const TEXT_LIMITS = { smsText: 300, voiceText: 400, mailSubject: 150, mailText: 1500 };
function cleanTexts(t) {
  const out = {};
  if (t && typeof t === 'object') Object.keys(DEFAULT_TEXTS).forEach((k) => { if (typeof t[k] === 'string' && t[k].trim()) out[k] = t[k].slice(0, TEXT_LIMITS[k]); });
  return out;
}
async function getTexts(env) { return { ...DEFAULT_TEXTS, ...cleanTexts(await env.KV.get('settings', 'json')) }; }
const fillText = (tpl, v) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m));
const xmlEsc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
async function twilio(env, path, params) {
  const r = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(env.TWILIO_SID) + '/' + path, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(env.TWILIO_SID + ':' + String(env.TWILIO_TOKEN).trim()), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  let detail = '';
  try { const j = await r.json(); detail = (j && j.message) || ''; } catch (e) { /* kein JSON */ }
  return { ok: r.ok, status: r.status, detail };
}
const smsSend = (env, to, text) => twilio(env, 'Messages.json', { To: '+' + to, From: env.TWILIO_FROM, Body: text });
const callSend = (env, to, text) => twilio(env, 'Calls.json', { To: '+' + to, From: env.TWILIO_FROM, Twiml: '<Response><Say language="de-DE" voice="alice">' + xmlEsc(text) + '</Say></Response>' });
async function mailSend(env, toEmail, toName, subject, text) {
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': String(env.BREVO_KEY).trim(), 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { name: env.MAIL_NAME || 'Familienkalender', email: String(env.MAIL_FROM).trim() }, to: [{ email: toEmail, name: toName }], subject, textContent: text }),
  });
  let detail = '';
  try { const j = await r.json(); detail = (j && j.message) || ''; } catch (e) { /* kein JSON */ }
  return { ok: r.ok, status: r.status, detail };
}
// Eine Nachricht ueber einen Kanal an eine Person senden
async function sendChannel(env, ch, m, v, texts) {
  const vars = { ...v, name: m.name };
  if (ch === 'sms') return smsSend(env, waNumber(m.phone || m.whatsapp), fillText(texts.smsText, vars));
  if (ch === 'call') return callSend(env, waNumber(m.phone || m.whatsapp), fillText(texts.voiceText, vars));
  if (ch === 'mail') return mailSend(env, m.email, m.name, fillText(texts.mailSubject, vars), fillText(texts.mailText, vars));
  return { ok: false, status: 0, detail: 'Unbekannter Kanal' };
}
const deDate = (s) => s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4);

async function runReminders(env) {
  const now = Date.now();
  let last = Number(await env.KV.get('lastrun')) || now - 5 * 60000;
  if (now - last > 3600000) last = now - 3600000;
  const state = (await env.KV.get('state', 'json')) || { members: [], events: [] };
  const subs = (await env.KV.get('subs', 'json')) || {};
  const hashes = Object.keys(subs);
  const names = {};
  (state.members || []).forEach((m) => { names[m.id] = m.name; });
  const outbox = {};
  const sentKeys = [];
  const waQueue = [];
  const chQueue = [];
  const add = (who, msg) => hashes.forEach((h) => { if (!who || subs[h].memberId === who) (outbox[h] = outbox[h] || []).push(msg); });

  const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
  const fromDay = isoDay(last - 86400000), toDay = isoDay(now + 4 * 86400000);
  for (const e of state.events || []) {
    if (e.remind === undefined || e.remind === null) continue;
    const dates = e.repeat ? occDates(e, fromDay, toDay) : [e.start];
    for (const date of dates) {
      const t = berlinToUtc(date, e.time || '09:00') - e.remind * 60000;
      if (!(t > last && t <= now)) continue;
      const dk = 'sent:' + e.id + ':' + t;
      if (await env.KV.get(dk)) continue;
      sentKeys.push(dk);
      const who = e.who && names[e.who] ? names[e.who] : 'Alle';
      add(e.who || '', { title: e.title, body: (e.time ? e.time + ' Uhr' : 'ganztägig') + ' · ' + who + ' · ' + leadText(e.remind) + (e.place ? ' · ' + e.place : '') });
      const rec2 = (state.members || []).filter((m) => !e.who || m.id === e.who);
      const vars = { titel: e.title, datum: deDate(date), zeit: e.time ? 'um ' + e.time + ' Uhr' : 'ganztägig', ort: e.place ? ', ' + e.place : '', ortText: e.place || '–', wer: who, vorlauf: leadText(e.remind) };
      if (e.remindSms && smsConfigured(env)) rec2.filter((m) => waNumber(m.phone || m.whatsapp)).forEach((m) => chQueue.push({ ch: 'sms', m, v: vars }));
      if (e.remindCall && smsConfigured(env)) rec2.filter((m) => waNumber(m.phone || m.whatsapp)).forEach((m) => chQueue.push({ ch: 'call', m, v: vars }));
      if (e.remindMail && mailConfigured(env)) rec2.filter((m) => m.email).forEach((m) => chQueue.push({ ch: 'mail', m, v: vars }));
      if (e.remindWa && waConfigured(env)) {
        const rec = (state.members || []).filter((m) => (!e.who || m.id === e.who) && waNumber(m.whatsapp || m.phone));
        rec.forEach((m) => waQueue.push({ to: waNumber(m.whatsapp || m.phone), params: [e.title, deDate(date) + (e.time ? ' ' + e.time + ' Uhr' : ' ganztägig') + ' (' + leadText(e.remind) + ')', who] }));
      }
    }
  }
  const year = new Date(now + 3600000).getUTCFullYear();
  for (const m of state.members || []) {
    if (!m.birthday) continue;
    const t = berlinToUtc(year + m.birthday.slice(4), '09:00');
    if (!(t > last && t <= now)) continue;
    const dk = 'sentb:' + m.id + ':' + year;
    if (await env.KV.get(dk)) continue;
    sentKeys.push(dk);
    const age = year - Number(m.birthday.slice(0, 4));
    add('', { title: 'Geburtstag', body: 'Heute hat ' + m.name + ' Geburtstag' + (age > 0 && age < 120 ? ' (' + age + ')' : '') });
  }
  let changed = false;
  for (const h of Object.keys(outbox)) {
    const st = await sendPush(env, h, subs[h].endpoint, outbox[h]).catch(() => 0);
    if (st === 404 || st === 410) { delete subs[h]; changed = true; }
  }
  if (chQueue.length) {
    const texts = await getTexts(env);
    for (const q of chQueue) {
      const res = await sendChannel(env, q.ch, q.m, q.v, texts).catch((err) => ({ ok: false, status: 0, detail: String(err && err.message) }));
      if (!res.ok) console.log('Kanal fehlgeschlagen', q.ch, res.status, res.detail);
    }
  }
  for (const w of waQueue) {
    const res = await waSend(env, w.to, w.params).catch((err) => ({ ok: false, status: 0, detail: String(err && err.message) }));
    if (!res.ok) console.log('WhatsApp fehlgeschlagen', res.status, res.detail);
  }
  if (changed) await env.KV.put('subs', JSON.stringify(subs));
  await Promise.all(sentKeys.map((k) => env.KV.put(k, '1', { expirationTtl: 172800 })));
  await env.KV.put('lastrun', String(now));
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
    if (e.repeat) {
      const freq = { d: 'FREQ=DAILY', w: 'FREQ=WEEKLY', '2w': 'FREQ=WEEKLY;INTERVAL=2', m: 'FREQ=MONTHLY', y: 'FREQ=YEARLY' }[e.repeat];
      L.push('RRULE:' + freq + (e.until ? ';UNTIL=' + d8(e.until) + (e.time ? 'T235959' : '') : ''));
      (e.skip || []).forEach((x) => L.push(e.time ? 'EXDATE:' + d8(x) + 'T' + e.time.replace(':', '') + '00' : 'EXDATE;VALUE=DATE:' + d8(x)));
    }
    if (e.place) L.push('LOCATION:' + icsEsc(e.place));
    L.push('SUMMARY:' + icsEsc(who + ': ' + e.title), 'CATEGORIES:' + icsEsc(e.cat || 'Termin'));
    if (e.note) L.push('DESCRIPTION:' + icsEsc(e.note));
    L.push('END:VEVENT');
  });
  (state.members || []).forEach((m) => {
    if (!m.birthday) return;
    L.push('BEGIN:VEVENT', 'UID:bd-' + m.id + '@familienkalender', 'DTSTAMP:' + stamp,
      'DTSTART;VALUE=DATE:' + d8(m.birthday), 'DTEND;VALUE=DATE:' + d8(nextDay(m.birthday)), 'RRULE:FREQ=YEARLY',
      'SUMMARY:' + icsEsc('Geburtstag: ' + m.name), 'CATEGORIES:Geburtstag', 'END:VEVENT');
  });
  L.push('END:VCALENDAR');
  return L.map(icsFold).join('\r\n') + '\r\n';
}

export default {
  async fetch(request, env) {
    const c = cors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: c });

    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/pending') {
      const h = url.searchParams.get('h') || '';
      if (!env.KV || !/^[0-9a-f]{64}$/.test(h)) return reply({ items: [] }, 200, c);
      const items = (await env.KV.get('pend:' + h, 'json')) || [];
      if (items.length) await env.KV.delete('pend:' + h);
      return reply({ items }, 200, c);
    }
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

    if (Number(request.headers.get('content-length') || 0) > 2000000) return reply({ error: 'Anfrage zu gross' }, 413, c);
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

    if (body.op === 'notify_status') {
      return reply({ sms: smsConfigured(env), call: smsConfigured(env), mail: mailConfigured(env), wa: waConfigured(env), texts: await getTexts(env), defaults: DEFAULT_TEXTS }, 200, c);
    }
    if (body.op === 'settings_put') {
      await env.KV.put('settings', JSON.stringify(cleanTexts(body.texts)));
      return reply({ texts: await getTexts(env) }, 200, c);
    }
    if (body.op === 'notify_test') {
      const ch = String(body.channel || '');
      if (!['sms', 'call', 'mail'].includes(ch)) return reply({ ok: false, error: 'Unbekannter Kanal' }, 200, c);
      if (ch === 'mail' ? !mailConfigured(env) : !smsConfigured(env)) return reply({ ok: false, error: 'Dieser Kanal ist im Worker noch nicht eingerichtet' }, 200, c);
      const m = state.members.find((x) => x.id === body.memberId);
      if (!m) return reply({ ok: false, error: 'Person nicht gefunden' }, 200, c);
      if (ch === 'mail' ? !m.email : !waNumber(m.phone || m.whatsapp)) return reply({ ok: false, error: ch === 'mail' ? 'Fuer diese Person ist keine E-Mail-Adresse hinterlegt' : 'Fuer diese Person ist keine Handynummer hinterlegt' }, 200, c);
      const v = { titel: 'Testnachricht', datum: deDate(new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' })), zeit: 'um 12:00 Uhr', ort: '', ortText: '–', wer: m.name, vorlauf: 'jetzt' };
      const res = await sendChannel(env, ch, m, v, await getTexts(env)).catch((err) => ({ ok: false, status: 0, detail: String(err && err.message) }));
      return reply({ ok: res.ok, status: res.status, detail: res.detail }, 200, c);
    }
    if (body.op === 'wa_status') {
      return reply({ configured: waConfigured(env), template: waConfigured(env) ? env.WA_TEMPLATE : '' }, 200, c);
    }
    if (body.op === 'wa_test') {
      if (!waConfigured(env)) return reply({ ok: false, error: 'WhatsApp ist im Worker noch nicht eingerichtet' }, 200, c);
      const m = state.members.find((x) => x.id === body.memberId);
      const to = m ? waNumber(m.whatsapp || m.phone) : '';
      if (!to) return reply({ ok: false, error: 'Fuer diese Person ist keine WhatsApp- oder Handynummer hinterlegt' }, 200, c);
      const res = await waSend(env, to, ['Testnachricht', deDate(new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' })), m.name]).catch((err) => ({ ok: false, status: 0, detail: String(err && err.message) }));
      return reply({ ok: res.ok, status: res.status, detail: res.detail }, 200, c);
    }
    if (body.op === 'push_sub') {
      const ep = String((body.sub && body.sub.endpoint) || '');
      if (!/^https:\/\/[^\s]{10,500}$/.test(ep)) return reply({ error: 'Ungueltiges Abo' }, 400, c);
      const mid = ID_RE.test(body.memberId || '') ? body.memberId : '';
      const subs = (await env.KV.get('subs', 'json')) || {};
      const h = await sha256hex(ep);
      if (!subs[h] && Object.keys(subs).length >= 40) return reply({ error: 'Limit erreicht' }, 413, c);
      subs[h] = { endpoint: ep, memberId: mid };
      await env.KV.put('subs', JSON.stringify(subs));
      return reply({ ok: true, count: Object.keys(subs).length }, 200, c);
    }
    if (body.op === 'push_unsub') {
      const subs = (await env.KV.get('subs', 'json')) || {};
      const h = await sha256hex(String(body.endpoint || ''));
      if (subs[h]) { delete subs[h]; await env.KV.put('subs', JSON.stringify(subs)); }
      return reply({ ok: true }, 200, c);
    }
    if (body.op === 'push_test') {
      if (!env.VAPID_PRIVATE || !env.VAPID_PUBLIC) return reply({ error: 'Push nicht eingerichtet' }, 500, c);
      const subs = (await env.KV.get('subs', 'json')) || {};
      const ep = String(body.endpoint || '');
      const h = await sha256hex(ep);
      if (!subs[h]) return reply({ error: 'Dieses Geraet ist nicht angemeldet' }, 404, c);
      const st = await sendPush(env, h, ep, [{ title: 'Familienkalender', body: 'So sehen Erinnerungen aus.' }]).catch((e) => 'Fehler: ' + (e && e.message ? e.message : e));
      if (st === 404 || st === 410) { delete subs[h]; await env.KV.put('subs', JSON.stringify(subs)); }
      return reply({ status: st }, 200, c);
    }
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
    // Eine gerade erst angelegte Person (unter 15 Minuten, Zeit vom Server) darf ohne Loeschkennwort wieder entfernt werden
    const recentMember = body.op === 'del' && body.kind === 'member' && (() => {
      const m = state.members.find((x) => x.id === body.id);
      return !!m && Date.now() - (Number(m.createdAt) || 0) < 15 * 60000;
    })();
    if ((body.op === 'photo_del' || body.op === 'del') && !recentMember) {
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
        if (isMember) item.createdAt = i >= 0 ? list[i].createdAt : Date.now(); // Anlegezeit nur der Server bestimmt
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
  async scheduled(event, env, ctx) {
    if (env.KV && env.VAPID_PRIVATE && env.VAPID_PUBLIC) ctx.waitUntil(runReminders(env));
  },
};

