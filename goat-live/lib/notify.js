// WhatsApp notifications. Works out who needs a message after each change, then sends approved templates
// through Gupshup (default) or Meta's Cloud API. Without credentials it runs in TEST mode: nothing is sent,
// every message is written to the log so you can see exactly what would go out.
//
// Templates (get these approved as "Utility"), variables in order:
//   soon  : {{1}} player/team  {{2}} opponent  {{3}} minutes  {{4}} time      — first time the match enters the top 10
//   next  : {{1}} player/team  {{2}} opponent  {{3}} court    {{4}} minutes   — match called to a court
//   later : {{1}} player/team  {{2}} opponent                                  — a "next" message was sent, then the match moved back
//
// Env: WA_PROVIDER=gupshup|meta, WA_TEMPLATE_SOON / WA_TEMPLATE_NEXT / WA_TEMPLATE_LATER (Gupshup template IDs or Meta template names)
//      Gupshup: GUPSHUP_API_KEY, GUPSHUP_SOURCE (your WhatsApp number, e.g. 9198xxxxxxx), GUPSHUP_APP_NAME
//      Meta:    META_TOKEN, META_PHONE_NUMBER_ID, WA_LANG (default en)
const BOARD = 10;
const env = (k) => (process.env[k] || '').trim();
const TPL = { soon: env('WA_TEMPLATE_SOON'), next: env('WA_TEMPLATE_NEXT'), later: env('WA_TEMPLATE_LATER') };
const PROVIDER = env('WA_PROVIDER').toLowerCase() || (env('GUPSHUP_API_KEY') ? 'gupshup' : env('META_TOKEN') ? 'meta' : '');
function configured() {
  if (PROVIDER === 'gupshup') return !!(env('GUPSHUP_API_KEY') && env('GUPSHUP_SOURCE') && env('GUPSHUP_APP_NAME') && TPL.soon && TPL.next && TPL.later);
  if (PROVIDER === 'meta') return !!(env('META_TOKEN') && env('META_PHONE_NUMBER_ID') && TPL.soon && TPL.next && TPL.later);
  return false;
}
const status = () => ({ provider: PROVIDER || 'none', ready: configured() });

// Indian numbers: 98765 43210 / 098765… / +91 98765… → 919876543210
function normPhone(p) {
  let s = String(p == null ? '' : p).trim();
  if (/^\d(\.\d+)?e\+?\d+$/i.test(s)) s = Number(s).toFixed(0); // Excel sometimes stores 9.87654321E9
  let d = s.replace(/\.0+$/, '').replace(/[^\d]/g, '');
  if (!d) return '';
  if (d.length === 10) d = '91' + d;
  else if (d.length === 11 && d[0] === '0') d = '91' + d.slice(1);
  return d.length >= 10 && d.length <= 15 ? d : '';
}

// Compare before/after and list the messages that are due. `sent[id]` = {soon, next, later} timestamps.
function detect(prev, next, sent) {
  const before = new Map((prev ? prev.matches : []).map((m) => [m.id, m]));
  const events = [];
  next.matches.forEach((m, i) => {
    const s = sent[m.id] || {};
    const toldNext = !!s.next && !(s.later && s.later >= s.next); // a "you're next" is currently standing
    const p = before.get(m.id), startedNow = m.status === 'live' && p && p.status === 'queued'; // started straight from the queue just now
    if ((m.status === 'called' || startedNow) && !toldNext) events.push({ kind: 'next', m }); // called to a court / started directly
    else if (m.status === 'queued' && toldNext) events.push({ kind: 'later', m });              // was told "next", now pushed back
    else if (m.status === 'queued' && i < BOARD && !s.soon && !s.next) events.push({ kind: 'soon', m }); // first time in the top 10
  });
  return events;
}

// Variables, matching the approved Gupshup templates:
//   soon  {{1}} player {{2}} opponent            "…is expected to start in about 30 minutes…"
//   next  {{1}} player {{2}} opponent {{3}} court "…is NEXT on Court {{3}}. Please report to Court {{3}}."
//   later {{1}} player {{2}} opponent
function params(kind, m, side) {
  const me = side === 'a' ? m.a : m.b, them = side === 'a' ? m.b : m.a;
  if (kind === 'next') return [me, them, String(m.court || '-')];
  return [me, them];
}
const PREVIEW = {
  soon: (p) => `Hi ${p[0]}, your match vs ${p[1]} at THE GOAT Badminton Tournament is expected to start in about 30 minutes. Please be at the venue and ready.`,
  next: (p) => `Hi ${p[0]}, your match vs ${p[1]} is NEXT. Please report to court No. ${p[2]}. Good Luck!`,
  later: (p) => `Hi ${p[0]}, sorry for the inconvenience — your match vs ${p[1]} has been moved a little later. We'll message you again when it's your turn.`,
};

async function deliver(to, kind, p) {
  if (!configured()) return { ok: true, test: true };
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 6000);
  try {
    if (PROVIDER === 'gupshup') {
      const body = new URLSearchParams({ channel: 'whatsapp', source: env('GUPSHUP_SOURCE'), destination: to, 'src.name': env('GUPSHUP_APP_NAME'),
        template: JSON.stringify({ id: TPL[kind], params: p }) });
      const r = await fetch('https://api.gupshup.io/wa/api/v1/template/msg', { method: 'POST', signal: ctl.signal,
        headers: { apikey: env('GUPSHUP_API_KEY'), 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      const j = await r.json().catch(() => ({}));
      return r.ok && j.status !== 'error' ? { ok: true, id: j.messageId } : { ok: false, error: j.message || 'HTTP ' + r.status };
    }
    const r = await fetch(`https://graph.facebook.com/v21.0/${env('META_PHONE_NUMBER_ID')}/messages`, { method: 'POST', signal: ctl.signal,
      headers: { Authorization: 'Bearer ' + env('META_TOKEN'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name: TPL[kind], language: { code: env('WA_LANG') || 'en' },
        components: [{ type: 'body', parameters: p.map((text) => ({ type: 'text', text })) }] } }) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, id: j.messages && j.messages[0] && j.messages[0].id } : { ok: false, error: (j.error && j.error.message) || 'HTTP ' + r.status };
  } catch (e) { return { ok: false, error: e.name === 'AbortError' ? 'timed out' : e.message }; }
  finally { clearTimeout(timer); }
}

// Work out and send everything that's due. Returns { sentPatch, log } for the caller to save.
async function run(prev, next, { contacts, sent, enabled }) {
  if (!enabled) return { sentPatch: {}, log: [] };
  const now = Date.now(), events = detect(prev, next, sent, now), sentPatch = {}, jobs = [];
  for (const { kind, m } of events) {
    sentPatch[m.id] = Object.assign({}, sent[m.id] || {}, sentPatch[m.id] || {}, { [kind]: now });
    const c = contacts[m.id] || {};
    for (const side of ['a', 'b']) {
      const to = normPhone(c[side]);
      const p = params(kind, m, side);
      const entry = { at: now, kind, to: to ? '+' + to : '', name: side === 'a' ? m.a : m.b, text: PREVIEW[kind](p) };
      if (!to) { jobs.push(Promise.resolve(Object.assign(entry, { status: 'no number' }))); continue; }
      jobs.push(deliver(to, kind, p).then((r) => Object.assign(entry, { status: r.test ? 'test (not sent)' : r.ok ? 'sent' : 'failed: ' + r.error })));
    }
  }
  return { sentPatch, log: await Promise.all(jobs) };
}

module.exports = { run, detect, normPhone, status, configured, PREVIEW };
