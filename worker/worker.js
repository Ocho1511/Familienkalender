// Familienkalender Worker (Cloudflare Workers + KV)
// Alle Aufrufe: POST /  mit JSON { pass, op, ... }
//   op "pull"                       -> { members, events }
//   op "put", kind, item            -> legt an / ersetzt (kind: "member" | "event", item.id)
//   op "del", kind, id              -> loescht
// Das Familien-Passwort steckt als Secret FAMILY_PASSWORD im Worker (wrangler secret put).
// Gespeichert wird alles in einem KV-Eintrag "state".

import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_ORIGINS = ['https://ocho1511.github.io'];
const MAX_EVENTS = 5000;
const MAX_MEMBERS = 30;
const ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
const DEFAULT_CATS = ['Aktivität', 'Sportveranstaltung', 'Schule', 'Klassenarbeit', 'Urlaub', 'Arzt', 'Geburtstag', 'Termin', 'Sonstiges'].map((name) => ({ name }));
// Arten mit Regel: Erinnerung x Minuten vorher (0 bis 30 Tage) ueber ausgewaehlte Kanaele
function cleanCats(list) {
  const out = [], seen = new Set();
  (Array.isArray(list) ? list : []).forEach((c) => {
    if (!c || out.length >= 20) return;
    const name = str(c.name, 30).replace(/[\r\n\t]+/g, ' ').trim();
    if (!name || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    const raw = Array.isArray(c.reminds) ? c.reminds : (c.remind !== null && c.remind !== undefined && c.remind !== '' ? [c.remind] : []);
    const leads = [...new Set(raw.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 86400))].sort((a, b) => b - a).slice(0, 6);
    const item = { name };
    if (leads.length) {
      item.reminds = leads;
      item.push = c.push !== false;
      ['wa', 'sms', 'mail', 'call'].forEach((k) => { if (c[k] === true) item[k] = true; });
    }
    out.push(item);
  });
  return out;
}
const snap = (st) => ({ members: st.members, events: st.events, cats: st.cats && st.cats.length ? st.cats : DEFAULT_CATS });
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
    'Access-Control-Allow-Headers': 'Content-Type, X-Pass',
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

const REMINDS = [-1, 0, 15, 30, 60, 120, 1440, 2880, 4320, 7200, 10080]; // -1 = bewusst keine Erinnerung
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
  const extra = Array.isArray(e.extra) && Number(e.remind) !== -1 ? [...new Set(e.extra.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 86400))].sort((a, b) => b - a).slice(0, 5) : [];
  const real = (hasRemind && Number(e.remind) >= 0) || extra.length > 0;
  return {
    id: e.id, title, who: ID_RE.test(e.who || '') ? e.who : '',
    cat: str(e.cat, 30).replace(/[\r\n\t]+/g, ' ').trim() || 'Termin',
    start: e.start, end, time: TIME_RE.test(e.time || '') ? e.time : '',
    note: str(e.note, 500).trim(), createdAt: Number(e.createdAt) || Date.now(),
    remind: hasRemind ? Number(e.remind) : undefined,
    remindWa: real && (e.remindWa === true || e.remindWa === 'true') ? true : undefined,
    remindSms: real && e.remindSms === true ? true : undefined,
    remindMail: real && e.remindMail === true ? true : undefined,
    remindCall: real && e.remindCall === true ? true : undefined,
    autoSend: e.autoSend === true ? true : e.autoSend === false ? false : undefined,
    priv: e.priv === true ? true : undefined,
    extra: extra.length ? extra : undefined,
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
  const d = Math.round(min / 1440);
  return 'in ' + d + (d >= 2 ? ' Tagen' : ' Tag');
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

const CHANNELS = ['wa', 'sms', 'mail', 'call'];
// Automatisches Senden je Kanal (Setup). Aeltere Gesamt-Einstellung 'autosend' gilt, solange es keine Kanalwerte gibt.
async function getAutoCh(env) {
  const o = await env.KV.get('autoch', 'json');
  if (o) return { wa: o.wa !== false, sms: o.sms !== false, mail: o.mail !== false, call: o.call !== false };
  const all = (await env.KV.get('autosend')) !== '0';
  return { wa: all, sms: all, mail: all, call: all };
}

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
  const add = (who, msg) => hashes.forEach((h) => { if (!who || subs[h].memberId === who) (outbox[h] = outbox[h] || []).push({ ...msg, silent: subs[h].sound === false }); });

  const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
  const fromDay = isoDay(last - 86400000), toDay = isoDay(now + 62 * 86400000);
  const autoMap = await getAutoCh(env);
  const catRules = {};
  (state.cats || []).forEach((c) => { catRules[c.name] = c; });
  for (const e of state.events || []) {
    // eigene Einstellung des Termins hat Vorrang, sonst gilt die Regel der Art; zusaetzliche Zeitpunkte kommen dazu
    let leads = [], fl = null;
    const evFl = { push: true, wa: !!e.remindWa, sms: !!e.remindSms, mail: !!e.remindMail, call: !!e.remindCall };
    if (e.remind !== undefined && e.remind !== null) {
      if (e.remind >= 0) { leads = [e.remind]; fl = evFl; }
    } else {
      const rule = catRules[e.cat];
      const rl = rule ? (rule.reminds || (rule.remind !== undefined ? [rule.remind] : [])) : [];
      if (rl.length) { leads = rl.slice(); fl = { push: rule.push !== false, wa: !!rule.wa, sms: !!rule.sms, mail: !!rule.mail, call: !!rule.call }; }
      else if (e.extra && e.extra.length) fl = evFl;
    }
    if (fl && e.extra && !(e.remind < 0)) leads = leads.concat(e.extra);
    leads = [...new Set(leads)];
    if (!fl || !leads.length) continue;
    const dates = e.repeat ? occDates(e, fromDay, toDay) : [e.start];
    // Grundeinstellung (Setup) gilt, sofern der Termin sie nicht ueberschreibt; Push bleibt immer
    const allowCh = (k) => (e.autoSend === undefined ? autoMap[k] : e.autoSend);
    for (const date of dates) for (const lead of leads) {
      const eff = { remind: lead, ...fl };
      CHANNELS.forEach((k) => { if (!allowCh(k)) eff[k] = false; });
      const t = berlinToUtc(date, e.time || '09:00') - lead * 60000;
      if (!(t > last && t <= now)) continue;
      const dk = 'sent:' + e.id + ':' + t;
      if (await env.KV.get(dk)) continue;
      sentKeys.push(dk);
      const who = e.who && names[e.who] ? names[e.who] : 'Alle';
      if (eff.push) add(e.who || '', { title: e.title, body: (e.time ? e.time + ' Uhr' : 'ganztägig') + ' · ' + who + ' · ' + leadText(eff.remind) + (e.place ? ' · ' + e.place : '') });
      const rec2 = (state.members || []).filter((m) => !e.who || m.id === e.who);
      const vars = { titel: e.title, datum: deDate(date), zeit: e.time ? 'um ' + e.time + ' Uhr' : 'ganztägig', ort: e.place ? ', ' + e.place : '', ortText: e.place || '–', wer: who, vorlauf: leadText(eff.remind) };
      if (eff.sms && smsConfigured(env)) rec2.filter((m) => waNumber(m.phone || m.whatsapp)).forEach((m) => chQueue.push({ ch: 'sms', m, v: vars }));
      if (eff.call && smsConfigured(env)) rec2.filter((m) => waNumber(m.phone || m.whatsapp)).forEach((m) => chQueue.push({ ch: 'call', m, v: vars }));
      if (eff.mail && mailConfigured(env)) rec2.filter((m) => m.email).forEach((m) => chQueue.push({ ch: 'mail', m, v: vars }));
      if (eff.wa && waConfigured(env)) {
        const rec = (state.members || []).filter((m) => (!e.who || m.id === e.who) && waNumber(m.whatsapp || m.phone));
        rec.forEach((m) => waQueue.push({ to: waNumber(m.whatsapp || m.phone), params: [e.title, deDate(date) + (e.time ? ' ' + e.time + ' Uhr' : ' ganztägig') + ' (' + leadText(eff.remind) + ')', who] }));
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

// ---- Outlook -> Familienkalender: als privat markierte Termine aus dem Outlook-ICS-Link einlesen ----
const OL_HOST_RE = /(^|\.)(office365\.com|outlook\.com|live\.com|office\.com|microsoft\.com)$/i;
const BERLIN_TZ = ['W. Europe Standard Time', 'Europe/Berlin', 'Romance Standard Time', 'Central Europe Standard Time', 'Central European Standard Time', 'Europe/Vienna', 'Europe/Zurich'];
function icsUnfold(t) { return String(t).replace(/\r?\n[ \t]/g, '').split(/\r?\n/); }
function icsUnesc(v) { return String(v || '').replace(/\\[nN]/g, ' ').replace(/\\([,;\\])/g, '$1').trim(); }
function tzOffset(zone, ts) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const o = {};
  fmt.formatToParts(new Date(ts)).forEach((p) => { o[p.type] = p.value; });
  return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second) - ts;
}
// "20271202T190000" (+ TZID) -> { date: 'YYYY-MM-DD', time: 'HH:MM' | '' } in deutscher Ortszeit
function parseDt(val, params) {
  const m = String(val).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const date = m[1] + '-' + m[2] + '-' + m[3];
  if (m[4] === undefined) return { date, time: '' };
  const tz = m[7] ? 'UTC' : String((params && params.TZID) || '').replace(/^"|"$/g, '');
  if (!tz || BERLIN_TZ.includes(tz)) return { date, time: m[4] + ':' + m[5] };
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let utc = guess;
  if (!/^(utc|etc\/utc)$/i.test(tz)) { try { utc = guess - tzOffset(tz, guess); } catch (e) { return { date, time: m[4] + ':' + m[5] }; } }
  const dt = new Date(utc);
  return { date: dt.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }), time: dt.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) };
}
function parseIcs(text) {
  const evs = [];
  let cur = null;
  for (const line of icsUnfold(text)) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) evs.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const head = line.slice(0, i).split(';');
    const name = head[0].toUpperCase();
    const params = {};
    head.slice(1).forEach((x) => { const k = x.indexOf('='); if (k > 0) params[x.slice(0, k).toUpperCase()] = x.slice(k + 1); });
    const val = line.slice(i + 1);
    if (name === 'EXDATE') (cur.exdate = cur.exdate || []).push(...val.split(',').map((v) => ({ v, params })));
    else if (!(name in cur)) cur[name] = { val, params };
  }
  return evs;
}
const prevDay = (s) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
function untilFromCount(start, rep, n) {
  const d = new Date(start + 'T00:00:00Z');
  const k = Math.max(0, n - 1);
  if (rep === 'd') d.setUTCDate(d.getUTCDate() + k);
  else if (rep === 'w') d.setUTCDate(d.getUTCDate() + 7 * k);
  else if (rep === '2w') d.setUTCDate(d.getUTCDate() + 14 * k);
  else if (rep === 'm') d.setUTCMonth(d.getUTCMonth() + k);
  else d.setUTCFullYear(d.getUTCFullYear() + k);
  return d.toISOString().slice(0, 10);
}
function icsToEvents(text, today) {
  const all = parseIcs(text);
  const out = [];
  let priv = 0, simplified = 0;
  for (const c of all) {
    if (c['RECURRENCE-ID']) continue;
    if (c.STATUS && /CANCELLED/i.test(c.STATUS.val)) continue;
    const cls = ((c.CLASS && c.CLASS.val) || '').toUpperCase();
    if (cls !== 'PRIVATE' && cls !== 'CONFIDENTIAL') continue;
    priv++;
    const uid = c.UID && c.UID.val;
    if (!uid || !c.DTSTART) continue;
    const st = parseDt(c.DTSTART.val, c.DTSTART.params);
    if (!st) continue;
    const en = c.DTEND ? parseDt(c.DTEND.val, c.DTEND.params) : null;
    let end = '';
    if (en) { if (!st.time) { const ex = prevDay(en.date); end = ex > st.date ? ex : ''; } else end = en.date > st.date ? en.date : ''; }
    const ev = { uid, title: icsUnesc(c.SUMMARY && c.SUMMARY.val) || 'Privater Termin', start: st.date, end, time: st.time, place: icsUnesc(c.LOCATION && c.LOCATION.val) };
    if (c.RRULE) {
      const r = {};
      c.RRULE.val.split(';').forEach((x) => { const k = x.indexOf('='); if (k > 0) r[x.slice(0, k)] = x.slice(k + 1); });
      const iv = Number(r.INTERVAL || 1);
      const multi = (r.BYDAY || '').includes(',') || r.BYSETPOS || r.BYMONTHDAY && r.FREQ !== 'MONTHLY';
      const rep = multi ? null : r.FREQ === 'DAILY' && iv === 1 ? 'd' : r.FREQ === 'WEEKLY' && iv === 1 ? 'w' : r.FREQ === 'WEEKLY' && iv === 2 ? '2w' : r.FREQ === 'MONTHLY' && iv === 1 && !r.BYDAY ? 'm' : r.FREQ === 'YEARLY' && iv === 1 ? 'y' : null;
      if (rep) {
        ev.repeat = rep; ev.end = '';
        if (r.UNTIL) { const u = parseDt(r.UNTIL, {}); if (u) ev.until = u.date; }
        else if (r.COUNT) ev.until = untilFromCount(st.date, rep, Number(r.COUNT));
        ev.skip = (c.exdate || []).map((x) => parseDt(x.v, x.params)).filter(Boolean).map((x) => x.date);
      } else simplified++;
    }
    const last = ev.repeat ? (ev.until || '9999-12-31') : (ev.end || ev.start);
    if (last < today) continue;
    out.push(ev);
  }
  return { total: all.length, priv, simplified, events: out };
}
async function syncOutlook(env) {
  const cfg = (await env.KV.get('outlook', 'json')) || {};
  const done = async (r) => { cfg.last = Date.now(); cfg.status = r; await env.KV.put('outlook', JSON.stringify(cfg)); return r; };
  if (!cfg.url) return { ok: false, error: 'Kein Outlook-Link hinterlegt' };
  let u;
  try { u = new URL(String(cfg.url).replace(/^webcal:/i, 'https:')); } catch (e) { return done({ ok: false, error: 'Der Link ist ungueltig' }); }
  if (u.protocol !== 'https:' || !OL_HOST_RE.test(u.hostname)) return done({ ok: false, error: 'Nur Outlook-Links sind erlaubt (outlook.office365.com, outlook.live.com)' });
  let text = '';
  try {
    const r = await fetch(u.toString(), { headers: { 'User-Agent': 'Familienkalender' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return done({ ok: false, error: 'Der Outlook-Link antwortet mit Status ' + r.status });
    text = await r.text();
  } catch (e) { return done({ ok: false, error: 'Der Outlook-Link ist nicht erreichbar' }); }
  if (!text.includes('BEGIN:VCALENDAR')) return done({ ok: false, error: 'Der Link liefert keinen Kalender' });
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  const res = icsToEvents(text, today);
  const state = (await env.KV.get('state', 'json')) || { members: [], events: [] };
  state.events = state.events || [];
  const who = cfg.who && (state.members || []).some((m) => m.id === cfg.who) ? cfg.who : '';
  const keep = new Set();
  let added = 0, updated = 0, removed = 0;
  for (const ev of res.events) {
    const id = 'ol' + (await sha256hex(ev.uid)).slice(0, 20);
    keep.add(id);
    const i = state.events.findIndex((x) => x.id === id);
    const old = i >= 0 ? state.events[i] : null;
    const item = cleanEvent({ ...(old || {}), id, title: ev.title, who, cat: old ? old.cat : 'Termin', start: ev.start, end: ev.end, time: ev.time, place: ev.place || undefined, repeat: ev.repeat, until: ev.until, skip: ev.skip, priv: true, createdAt: old ? old.createdAt : Date.now() });
    if (!item) continue;
    item.src = 'outlook';
    if (old && old.att) item.att = old.att;
    if (i >= 0) { if (JSON.stringify(old) !== JSON.stringify(item)) updated++; state.events[i] = item; }
    else if (state.events.length < MAX_EVENTS) { state.events.push(item); added++; }
  }
  const before = state.events.length;
  state.events = state.events.filter((x) => {
    if (x.src !== 'outlook' || keep.has(x.id)) return true;
    const last = x.repeat ? (x.until || '9999-12-31') : (x.end || x.start);
    return last < today; // vergangene Termine bleiben als Verlauf
  });
  removed = before - state.events.length;
  if (added || updated || removed) await env.KV.put('state', JSON.stringify(state));
  return done({ ok: true, total: res.total, priv: res.priv, simplified: res.simplified, added, updated, removed });
}
async function syncOutlookIfDue(env) {
  const cfg = (await env.KV.get('outlook', 'json')) || {};
  if (!cfg.url || (cfg.last && Date.now() - cfg.last < 30 * 60000)) return;
  await syncOutlook(env);
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
function buildIcs(state, onlyPriv) {
  const names = {};
  (state.members || []).forEach((m) => { names[m.id] = m.name; });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Familienkalender//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + (onlyPriv ? 'Familienkalender (privat)' : 'Familienkalender'), 'X-PUBLISHED-TTL:PT1H', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H'];
  (state.events || []).forEach((e) => {
    if (e.src === 'outlook' || (onlyPriv && !e.priv)) return;
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
    if (!m.birthday || onlyPriv) return;
    L.push('BEGIN:VEVENT', 'UID:bd-' + m.id + '@familienkalender', 'DTSTAMP:' + stamp,
      'DTSTART;VALUE=DATE:' + d8(m.birthday), 'DTEND;VALUE=DATE:' + d8(nextDay(m.birthday)), 'RRULE:FREQ=YEARLY',
      'SUMMARY:' + icsEsc('Geburtstag: ' + m.name), 'CATEGORIES:Geburtstag', 'END:VEVENT');
  });
  L.push('END:VCALENDAR');
  return L.map(icsFold).join('\r\n') + '\r\n';
}

// ---- KI: eine gescannte Seite lesen und Termine vorschlagen (Claude API, offizielles SDK) ----
const AI_MODEL = 'claude-opus-5-5';
const AI_PER_DAY = 40;
// Ohne eigenen Schluessel nutzt der Kalender den vorhandenen KI-Proxy der Wein-/Gin-/Whiskey-App (der Schluessel bleibt dort).
const AI_PROXY = 'https://weinkeller-scan-proxy.scan-proxy.workers.dev';
const AI_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const nullable = (t) => ({ anyOf: [{ type: t }, { type: 'null' }] });
const AI_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, date: { type: 'string' }, end_date: nullable('string'), time: nullable('string'), place: nullable('string'), category: nullable('string'), person: nullable('string'), note: nullable('string') },
        required: ['title', 'date', 'end_date', 'time', 'place', 'category', 'person', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'events'],
  additionalProperties: false,
};
function aiSystem(today, weekday, catNames, memberNames) {
  return 'Du liest eingescannte oder fotografierte Seiten (Briefe von der Schule, Elternbriefe, Einladungen, Flyer, Stundenpläne, Screenshots) und findest alle konkreten Termine darauf. '
    + 'Heute ist ' + weekday + ', der ' + today + '. '
    + 'Gib nur Termine zurück, die klar auf der Seite stehen. Erfinde nichts. Steht keiner auf der Seite, gib eine leere Liste zurück. '
    + 'Datum immer als YYYY-MM-DD. Fehlt das Jahr, nimm das nächste Datum in der Zukunft. Bei mehrtägigen Terminen ist end_date das letzte Datum, sonst null. '
    + 'Uhrzeit als HH:MM im 24-Stunden-Format, sonst null. Der Titel ist kurz (höchstens 60 Zeichen) und enthält kein Datum. Ort nur, wenn er genannt wird. '
    + 'category: genau einer der Werte [' + catNames.join(', ') + '] oder null. '
    + 'person: genau einer der Namen [' + memberNames.join(', ') + '], wenn die Seite erkennen lässt, für wen der Termin gilt (zum Beispiel der Name des Kindes), sonst null. '
    + 'note: wichtige Zusatzangaben kurz (mitbringen, Kosten, Anmeldefrist, Ansprechpartner), sonst null. summary: ein Satz auf Deutsch, worum es auf der Seite geht.';
}
// JSON aus Modelltext holen: auch mit Code-Zaun, Text drumherum oder abgeschnitten (dann die vollstaendigen Termine retten)
function lenientJson(t) {
  t = String(t || '').replace(/```(?:json)?/gi, '');
  const a = t.indexOf('{');
  if (a < 0) return null;
  const b = t.lastIndexOf('}');
  if (b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* weiter */ } }
  const sm = t.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const evs = [];
  const k = t.indexOf('[', t.indexOf('"events"'));
  if (k < 0) return null;
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = k + 1; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') { if (depth++ === 0) start = i; }
    else if ((ch === '}' || ch === ']') && --depth === 0 && start >= 0) { try { evs.push(JSON.parse(t.slice(start, i + 1))); } catch (e) { /* ueberspringen */ } start = -1; }
  }
  return evs.length || sm ? { summary: sm ? sm[1] : '', events: evs } : null;
}
function cleanAiEvents(list, catNames, memberNames) {
  const out = [];
  const todayBerlin = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  for (const e of Array.isArray(list) ? list : []) {
    if (out.length >= 60 || !e) continue;
    const title = str(e.title, 120).replace(/[\r\n\t]+/g, ' ').trim();
    const date = DATE_RE.test(e.date || '') && e.date >= '2000-01-01' && e.date <= '2100-12-31' ? e.date : '';
    if (!title || !date) continue;
    // Termine in der Vergangenheit ignorieren (mehrtaegige gelten bis zum letzten Tag)
    const last = DATE_RE.test(e.end_date || '') && e.end_date > date ? e.end_date : date;
    if (last < todayBerlin) continue;
    out.push({
      title, date,
      end_date: DATE_RE.test(e.end_date || '') && e.end_date > date ? e.end_date : '',
      time: TIME_RE.test(e.time || '') ? e.time : '',
      place: str(e.place, 80).replace(/[\r\n\t]+/g, ' ').trim(),
      category: catNames.includes(e.category) ? e.category : '',
      person: memberNames.includes(e.person) ? e.person : '',
      note: str(e.note, 500).trim(),
    });
  }
  return out;
}
async function aiExtract(env, state, body) {
  const type = String(body.type || '').toLowerCase();
  const data = String(body.data || '');
  if (!AI_TYPES.includes(type)) return { ok: false, error: 'Nur PDF, JPEG, PNG oder WebP' };
  if (!/^[A-Za-z0-9+/=]+$/.test(data) || data.length < 100) return { ok: false, error: 'Die Datei ist leer oder ungueltig' };
  if (data.length > 5600000) return { ok: false, error: 'Die Datei ist zu gross (max. etwa 4 MB)' };
  const dayKey = 'ai:' + new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  const used = parseInt((await env.KV.get(dayKey)) || '0', 10) || 0;
  if (used >= AI_PER_DAY) return { ok: false, error: 'Das Tageslimit fuer KI-Auswertungen ist erreicht (' + AI_PER_DAY + '). Morgen geht es wieder.' };
  await env.KV.put(dayKey, String(used + 1), { expirationTtl: 60 * 60 * 30 });
  const catNames = (state.cats && state.cats.length ? state.cats : DEFAULT_CATS).map((x) => x.name);
  const memberNames = (state.members || []).map((m) => m.name);
  const now = new Date();
  const today = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  const weekday = now.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'long' });
  const block = type === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: type, data } }
    : { type: 'image', source: { type: 'base64', media_type: type, data } };
  const params = {
    model: AI_MODEL,
    max_tokens: 16000,
    system: aiSystem(today, weekday, catNames, memberNames),
    messages: [{ role: 'user', content: [block, { type: 'text', text: 'Lies die Seite und gib alle Termine als JSON zurück.' }] }],
    output_config: { format: { type: 'json_schema', schema: AI_SCHEMA } },
  };
  if (!env.ANTHROPIC_API_KEY) {
    // Weg ueber den gemeinsamen Proxy: kein Structured Output, daher JSON im Prompt verlangen
    try {
      const sysP = params.system + ' Gib die Termine kompakt als JSON aus, ohne Leerzeichen und Zeilenumbrueche: {"summary":"...","events":[[title,date,end_date,time,place,category,person,note],...]} (jeder Termin ein Array in genau dieser Reihenfolge, nicht vorhandene Angaben null, Notizen hoechstens 80 Zeichen). Kein Text davor oder danach.';
      let all = [], summary = '', truncated = false;
      for (let round = 0; round < 4; round++) {
        const msgs = JSON.parse(JSON.stringify(params.messages));
        if (all.length) {
          msgs[0].content.push({ type: 'text', text: 'Diese Termine sind schon erfasst, nenne sie NICHT noch einmal, sondern nur die weiteren Termine der Seite (leere Liste, wenn es keine mehr gibt): ' + all.map((e) => e.date + ' ' + e.title).join('; ') });
        }
        const r = await fetch(AI_PROXY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: AI_MODEL, max_tokens: 8000, system: sysP, messages: msgs }), signal: AbortSignal.timeout(90000) });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j) { if (all.length) { truncated = true; break; } return { ok: false, error: r.status === 429 ? 'Gerade zu viele Anfragen. Bitte in einer Minute noch einmal.' : 'Fehler bei der KI (Status ' + r.status + ').' }; }
        if (j.stop_reason === 'refusal') { if (all.length) break; return { ok: false, error: 'Die KI hat diese Seite nicht ausgewertet.' }; }
        const t = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
        const parsed = lenientJson(t);
        if (!parsed) { if (all.length) { truncated = true; break; } return { ok: false, error: 'Die Antwort der KI war nicht lesbar (' + (j.stop_reason || 'unbekannt') + ', ' + t.length + ' Zeichen). Bitte noch einmal versuchen oder eine einzelne Seite scannen.' }; }
        if (!summary) summary = str(parsed.summary, 300);
        const got = (Array.isArray(parsed.events) ? parsed.events : []).map((e) => Array.isArray(e) ? { title: e[0], date: e[1], end_date: e[2], time: e[3], place: e[4], category: e[5], person: e[6], note: e[7] } : e).filter((e) => e && e.title && e.date);
        const seen = new Set(all.map((e) => e.date + '|' + String(e.title).toLowerCase()));
        const fresh = got.filter((e) => !seen.has(e.date + '|' + String(e.title).toLowerCase()));
        all = all.concat(fresh);
        if (j.stop_reason !== 'max_tokens' || !fresh.length) break;
        if (round === 3) truncated = true;
      }
      return { ok: true, truncated, summary, events: cleanAiEvents(all, catNames, memberNames) };
    } catch (e) { return { ok: false, error: 'Die KI ist gerade nicht erreichbar.' }; }
  }
  const client = new Anthropic({ apiKey: String(env.ANTHROPIC_API_KEY).trim(), maxRetries: 1, timeout: 90000 });
  try {
    let msg;
    try {
      // Bei einer Ablehnung durch die Sicherheitsfilter springt die API selbst auf ein Ersatzmodell
      msg = await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    } catch (e) {
      if (!(e instanceof Anthropic.BadRequestError)) throw e;
      msg = await client.messages.create(params);
    }
    if (msg.stop_reason === 'refusal') return { ok: false, error: 'Die KI hat diese Seite nicht ausgewertet.' };
    const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return { ok: false, error: 'Die Antwort der KI war nicht lesbar. Bitte noch einmal versuchen.' }; }
    return { ok: true, truncated: msg.stop_reason === 'max_tokens', summary: str(parsed.summary, 300), events: cleanAiEvents(parsed.events, catNames, memberNames) };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { ok: false, error: 'Der API-Schluessel wurde abgelehnt. Bitte pruefen.' };
    if (e instanceof Anthropic.RateLimitError) return { ok: false, error: 'Gerade zu viele Anfragen. Bitte in einer Minute noch einmal.' };
    if (e instanceof Anthropic.BadRequestError) return { ok: false, error: 'Die Anfrage wurde abgelehnt: ' + str(e.message, 200) };
    if (e instanceof Anthropic.APIError) return { ok: false, error: 'Fehler bei der KI (Status ' + e.status + ').' };
    return { ok: false, error: 'Die KI ist gerade nicht erreichbar.' };
  }
}

const ATT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const MAX_ATT = 9 * 1024 * 1024;
const MAX_ATT_PER_EVENT = 5;
const randomId = () => { const a = new Uint8Array(10); crypto.getRandomValues(a); return Array.from(a, (x) => (x % 36).toString(36)).join(''); };

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
      return new Response(buildIcs(st, url.searchParams.get('p') === '1'), { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=300' } });
    }
    if (request.method === 'POST' && (url.pathname === '/att/put' || url.pathname === '/att/get')) {
      if (!env.KV || !env.FAMILY_PASSWORD) return reply({ error: 'Worker nicht eingerichtet' }, 500, c);
      const ipA = request.headers.get('CF-Connecting-IP') || 'anon';
      if ((await failCount(env, ipA)) >= 10) return reply({ error: 'Zu viele Versuche. Bitte spaeter erneut.' }, 429, c);
      if (!(await sameText(str(request.headers.get('X-Pass'), 200).trim(), String(env.FAMILY_PASSWORD).trim()))) {
        await addFail(env, ipA);
        return reply({ error: 'Falsches Passwort' }, 401, c);
      }
      const stA = (await env.KV.get('state', 'json')) || { members: [], events: [] };
      stA.events = stA.events || [];
      if (url.pathname === '/att/get') {
        const id = url.searchParams.get('id') || '';
        if (!ID_RE.test(id) || !stA.events.some((e) => (e.att || []).some((a) => a.id === id))) return reply({ error: 'Anlage nicht gefunden' }, 404, c);
        const o = await env.KV.getWithMetadata('att:' + id, 'arrayBuffer');
        if (!o || !o.value) return reply({ error: 'Anlage nicht gefunden' }, 404, c);
        return new Response(o.value, { headers: { 'Content-Type': (o.metadata && o.metadata.t) || 'application/octet-stream', 'Cache-Control': 'private, no-store', ...c } });
      }
      const ev = stA.events.find((e) => e.id === (url.searchParams.get('e') || ''));
      if (!ev) return reply({ error: 'Termin nicht gefunden' }, 404, c);
      const type = String(url.searchParams.get('t') || '').toLowerCase();
      if (!ATT_TYPES.includes(type)) return reply({ error: 'Nur PDF, JPEG, PNG oder WebP' }, 400, c);
      if (Number(request.headers.get('content-length') || 0) > MAX_ATT) return reply({ error: 'Datei zu gross (max. 9 MB)' }, 413, c);
      if ((ev.att || []).length >= MAX_ATT_PER_EVENT) return reply({ error: 'Maximal ' + MAX_ATT_PER_EVENT + ' Anlagen je Termin' }, 413, c);
      const buf = await request.arrayBuffer();
      if (!buf.byteLength) return reply({ error: 'Leere Datei' }, 400, c);
      if (buf.byteLength > MAX_ATT) return reply({ error: 'Datei zu gross (max. 9 MB)' }, 413, c);
      const name = str(url.searchParams.get('n'), 80).replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').trim() || 'Anlage';
      const id = randomId();
      await env.KV.put('att:' + id, buf, { metadata: { t: type, n: name } });
      ev.att = (ev.att || []).concat([{ id, name, type, size: buf.byteLength, added: Date.now() }]);
      await env.KV.put('state', JSON.stringify(stA));
      return reply(snap(stA), 200, c);
    }
    if (request.method !== 'POST') return reply({ error: 'POST erwartet' }, 405, c);
    if (!env.KV || !env.FAMILY_PASSWORD) return reply({ error: 'Worker nicht eingerichtet' }, 500, c);

    if (Number(request.headers.get('content-length') || 0) > 6000000) return reply({ error: 'Anfrage zu gross' }, 413, c);
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

    if (body.op === 'ai_status') return reply({ configured: true, model: AI_MODEL, perDay: AI_PER_DAY }, 200, c);
    if (body.op === 'ai_extract') {
      return reply(await aiExtract(env, state, body), 200, c);
    }
    if (body.op === 'notify_status') {
      const autoCh = await getAutoCh(env);
      return reply({ autoCh, autoSend: CHANNELS.some((k) => autoCh[k]), sms: smsConfigured(env), call: smsConfigured(env), mail: mailConfigured(env), wa: waConfigured(env), texts: await getTexts(env), defaults: DEFAULT_TEXTS }, 200, c);
    }
    if (body.op === 'settings_put') {
      if (typeof body.autoSend === 'boolean' || (body.autoCh && typeof body.autoCh === 'object')) {
        const cur = await getAutoCh(env);
        if (typeof body.autoSend === 'boolean') CHANNELS.forEach((k) => { cur[k] = body.autoSend; });
        if (body.autoCh && typeof body.autoCh === 'object') CHANNELS.forEach((k) => { if (typeof body.autoCh[k] === 'boolean') cur[k] = body.autoCh[k]; });
        await env.KV.put('autoch', JSON.stringify(cur));
      }
      if (body.texts) await env.KV.put('settings', JSON.stringify(cleanTexts(body.texts)));
      return reply({ texts: await getTexts(env), autoCh: await getAutoCh(env) }, 200, c);
    }
    if (body.op === 'send_now') {
      const e = state.events.find((x) => x.id === body.id);
      if (!e) return reply({ ok: false, error: 'Termin nicht gefunden' }, 200, c);
      const date = DATE_RE.test(body.date || '') ? body.date : e.start;
      const want = [...new Set((Array.isArray(body.channels) ? body.channels : []).filter((x) => ['wa', 'sms', 'mail', 'call'].includes(x)))];
      if (!want.length) return reply({ ok: false, error: 'Kein Kanal gewaehlt' }, 200, c);
      const who = e.who && state.members.find((m) => m.id === e.who) ? state.members.find((m) => m.id === e.who).name : 'Alle';
      const rec = state.members.filter((m) => !e.who || m.id === e.who);
      const v = { titel: e.title, datum: deDate(date), zeit: e.time ? 'um ' + e.time + ' Uhr' : 'ganztägig', ort: e.place ? ', ' + e.place : '', ortText: e.place || '–', wer: who, vorlauf: 'jetzt' };
      const texts = await getTexts(env);
      const report = [];
      for (const ch of want) {
        const label = { wa: 'WhatsApp', sms: 'SMS', mail: 'E-Mail', call: 'Anruf' }[ch];
        const conf = ch === 'wa' ? waConfigured(env) : ch === 'mail' ? mailConfigured(env) : smsConfigured(env);
        if (!conf) { report.push(label + ': im Worker nicht eingerichtet'); continue; }
        const to = rec.filter((m) => ch === 'mail' ? m.email : ch === 'wa' ? waNumber(m.whatsapp || m.phone) : waNumber(m.phone || m.whatsapp));
        if (!to.length) { report.push(label + ': keine ' + (ch === 'mail' ? 'E-Mail-Adresse' : 'Nummer') + ' hinterlegt'); continue; }
        let okN = 0, fail = '';
        for (const m of to) {
          const res = ch === 'wa'
            ? await waSend(env, waNumber(m.whatsapp || m.phone), [e.title, deDate(date) + (e.time ? ' ' + e.time + ' Uhr' : ' ganztägig'), who]).catch((err) => ({ ok: false, status: 0, detail: String(err && err.message) }))
            : await sendChannel(env, ch, m, v, texts).catch((err) => ({ ok: false, status: 0, detail: String(err && err.message) }));
          if (res.ok) okN++; else fail = res.detail || ('Status ' + res.status);
        }
        report.push(label + ': ' + okN + ' von ' + to.length + ' gesendet' + (fail && okN < to.length ? ' (' + fail + ')' : ''));
      }
      return reply({ ok: true, report }, 200, c);
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
      subs[h] = { endpoint: ep, memberId: mid, sound: body.sound === undefined ? !(subs[h] && subs[h].sound === false) : body.sound !== false };
      await env.KV.put('subs', JSON.stringify(subs));
      return reply({ ok: true, count: Object.keys(subs).length }, 200, c);
    }
    if (body.op === 'push_state') {
      const subs = (await env.KV.get('subs', 'json')) || {};
      const sub = subs[await sha256hex(String(body.endpoint || ''))];
      return reply({ subscribed: !!sub, sound: sub ? sub.sound !== false : true, memberId: sub ? sub.memberId : '' }, 200, c);
    }
    if (body.op === 'push_sound') {
      const subs = (await env.KV.get('subs', 'json')) || {};
      const h = await sha256hex(String(body.endpoint || ''));
      if (!subs[h]) return reply({ error: 'Dieses Geraet ist nicht angemeldet' }, 404, c);
      subs[h].sound = body.sound !== false;
      await env.KV.put('subs', JSON.stringify(subs));
      return reply({ ok: true, sound: subs[h].sound }, 200, c);
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
      const st = await sendPush(env, h, ep, [{ title: 'Familienkalender', body: 'So sehen Erinnerungen aus.', silent: subs[h].sound === false }]).catch((e) => 'Fehler: ' + (e && e.message ? e.message : e));
      if (st === 404 || st === 410) { delete subs[h]; await env.KV.put('subs', JSON.stringify(subs)); }
      return reply({ status: st }, 200, c);
    }
    if (body.op === 'ics') {
      if (!env.ICS_TOKEN) return reply({ error: 'Outlook-Link nicht eingerichtet' }, 500, c);
      return reply({ url: url.origin + '/ics?t=' + String(env.ICS_TOKEN).trim(), urlPriv: url.origin + '/ics?p=1&t=' + String(env.ICS_TOKEN).trim() }, 200, c);
    }
    if (body.op === 'outlook_get') {
      const cfg = (await env.KV.get('outlook', 'json')) || {};
      let host = '';
      try { host = new URL(String(cfg.url || '').replace(/^webcal:/i, 'https:')).hostname; } catch (e) { /* kein Link */ }
      return reply({ hasUrl: !!cfg.url, host, who: cfg.who || '', last: cfg.last || 0, status: cfg.status || null }, 200, c);
    }
    if (body.op === 'outlook_put') {
      const raw = str(body.url, 1500).trim();
      const cfg = (await env.KV.get('outlook', 'json')) || {};
      if (raw === '' && body.clear === true) delete cfg.url;
      else if (raw) {
        let u;
        try { u = new URL(raw.replace(/^webcal:/i, 'https:')); } catch (e) { return reply({ ok: false, error: 'Der Link ist ungueltig' }, 200, c); }
        if (u.protocol !== 'https:' || !OL_HOST_RE.test(u.hostname)) return reply({ ok: false, error: 'Nur Outlook-Links sind erlaubt (outlook.office365.com, outlook.live.com)' }, 200, c);
        cfg.url = raw; cfg.last = 0; cfg.status = null;
      }
      cfg.who = ID_RE.test(body.who || '') && state.members.some((m) => m.id === body.who) ? body.who : '';
      await env.KV.put('outlook', JSON.stringify(cfg));
      return reply({ ok: true }, 200, c);
    }
    if (body.op === 'outlook_sync') {
      const r = await syncOutlook(env);
      return reply({ ...r, state: snap((await env.KV.get('state', 'json')) || { members: [], events: [] }) }, 200, c);
    }
    if (body.op === 'cats_put') {
      const cl = cleanCats(body.cats);
      if (cl.length) state.cats = cl; else delete state.cats;
      await env.KV.put('state', JSON.stringify(state));
      return reply(snap(state), 200, c);
    }
    if (body.op === 'reorder') {
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      state.members.forEach((m) => { const i = ids.indexOf(m.id); if (i >= 0) m.order = i; });
      await env.KV.put('state', JSON.stringify(state));
      return reply(snap(state), 200, c);
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
    const recentAtt = body.op === 'att_del' && (() => {
      const e = state.events.find((x) => x.id === body.eventId);
      const a = e && (e.att || []).find((x) => x.id === body.attId);
      return !!a && Date.now() - (Number(a.added) || 0) < 15 * 60000;
    })();
    if ((body.op === 'photo_del' || body.op === 'del' || body.op === 'att_del') && !recentMember && !recentAtt) {
      if (!env.ADMIN_PASSWORD) return reply({ error: 'Loeschkennwort nicht eingerichtet' }, 500, c);
      if (!(await sameText(str(body.admin, 200).trim(), String(env.ADMIN_PASSWORD).trim()))) {
        await addFail(env, ip);
        return reply({ error: 'Falsches Loeschkennwort' }, 403, c);
      }
    }
    if (body.op === 'att_del') {
      const e = state.events.find((x) => x.id === body.eventId);
      if (e && e.att) {
        e.att = e.att.filter((a) => a.id !== body.attId);
        if (!e.att.length) delete e.att;
        await env.KV.delete('att:' + String(body.attId));
        await env.KV.put('state', JSON.stringify(state));
      }
      return reply(snap(state), 200, c);
    }
    if (body.op === 'photo_del') {
      await env.KV.delete('photo');
      return reply({ photo: null }, 200, c);
    }
    if (body.op === 'pull') return reply(snap(state), 200, c);

    if (body.op === 'put' || body.op === 'del') {
      const isMember = body.kind === 'member';
      if (!isMember && body.kind !== 'event') return reply({ error: 'kind?' }, 400, c);
      const list = isMember ? state.members : state.events;
      if (body.op === 'put') {
        const item = isMember ? cleanMember(body.item) : cleanEvent(body.item);
        if (!item) return reply({ error: 'Ungueltige Daten' }, 400, c);
        const i = list.findIndex((x) => x.id === item.id);
        if (isMember) item.createdAt = i >= 0 ? list[i].createdAt : Date.now(); // Anlegezeit nur der Server bestimmt
        if (!isMember && i >= 0 && list[i].att) item.att = list[i].att; // Anlagen verwaltet nur der Server
        if (!isMember && i >= 0 && list[i].src) item.src = list[i].src; // Herkunft Outlook nur durch den Abgleich
        if (i >= 0) list[i] = item;
        else {
          if (list.length >= (isMember ? MAX_MEMBERS : MAX_EVENTS)) return reply({ error: 'Limit erreicht' }, 413, c);
          list.push(item);
        }
      } else {
        const i = list.findIndex((x) => x.id === body.id);
        if (i >= 0 && !isMember) for (const a of list[i].att || []) await env.KV.delete('att:' + a.id);
        if (i >= 0) list.splice(i, 1);
      }
      await env.KV.put('state', JSON.stringify(state));
      return reply(snap(state), 200, c);
    }
    return reply({ error: 'op?' }, 400, c);
  },
  async scheduled(event, env, ctx) {
    if (env.KV && env.VAPID_PRIVATE && env.VAPID_PUBLIC) ctx.waitUntil(runReminders(env));
    if (env.KV) ctx.waitUntil(syncOutlookIfDue(env));
  },
};

