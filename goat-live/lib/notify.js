// WhatsApp notifications through Gupshup (Enterprise or self-serve) or Meta's Cloud API.
//
// How delivery works (so nobody is silently missed):
//  1. After every change, plan() works out which messages are due ("soon", "next", "later") and creates one
//     DELIVERY per player (side A and side B separately).
//  2. processDue() sends due deliveries, 3 at a time, and checks every answer from Gupshup.
//  3. A failed send is retried automatically (up to 10 attempts, spaced 20 s … 10 min apart).
//  4. After 10 failed attempts the delivery is marked "failed" and listed in the Control Room under
//     "Couldn't reach — call these players".
//  5. A message that is no longer relevant (e.g. "coming up" for a match that already started) is skipped.
//  6. A phone number added later gets the message that player missed, if it is still relevant (followUps()).
// Without credentials everything runs in TEST mode: nothing is sent, everything is logged.
//
// Approved templates, variables in order:
//   soon  {{1}} player {{2}} opponent             "…is expected to start in about 30 minutes…"
//   next  {{1}} player {{2}} opponent {{3}} court "…is NEXT. Please report to court No. {{3}}. Good Luck!"
//   later {{1}} player {{2}} opponent
//
// Env: Gupshup Enterprise: GUPSHUP_USERID, GUPSHUP_TOKEN · self-serve: GUPSHUP_API_KEY, GUPSHUP_SOURCE, GUPSHUP_APP_NAME
//      Meta: META_TOKEN, META_PHONE_NUMBER_ID, WA_LANG · all: WA_TEMPLATE_SOON / WA_TEMPLATE_NEXT / WA_TEMPLATE_LATER
const BOARD = 10;
const MAX_ATTEMPTS = 10;
const env = (k) => (process.env[k] || '').trim();
const SCALE = Number(env('WA_TEST_BACKOFF_SCALE')) || 1; // tests only: shrink the waits
const BACKOFF = [0, 20e3, 40e3, 60e3, 120e3, 180e3, 300e3, 300e3, 600e3, 600e3].map((ms) => ms * SCALE); // wait before the next attempt, by attempts made
const GATEWAY = env('GUPSHUP_GATEWAY_URL') || 'https://mediaapi.smsgupshup.com/GatewayAPI/rest'; // override only for tests
const TPL = { soon: env('WA_TEMPLATE_SOON'), next: env('WA_TEMPLATE_NEXT'), later: env('WA_TEMPLATE_LATER') };
// Chosen from the credentials that exist (WA_PROVIDER only matters if both Gupshup kinds are present).
const PROVIDER = (() => {
  const want = env('WA_PROVIDER').toLowerCase();
  const ent = !!(env('GUPSHUP_USERID') && env('GUPSHUP_TOKEN')), self = !!env('GUPSHUP_API_KEY'), meta = !!env('META_TOKEN');
  if (want === 'meta' && meta) return 'meta';
  if (ent && (!self || want === 'gupshup-enterprise')) return 'gupshup-enterprise';
  if (self) return 'gupshup';
  if (meta) return 'meta';
  return ent ? 'gupshup-enterprise' : '';
})();
function missing() {
  const need = PROVIDER === 'meta' ? ['META_TOKEN', 'META_PHONE_NUMBER_ID'] : PROVIDER === 'gupshup' ? ['GUPSHUP_API_KEY', 'GUPSHUP_SOURCE', 'GUPSHUP_APP_NAME'] : ['GUPSHUP_USERID', 'GUPSHUP_TOKEN'];
  return need.concat(['WA_TEMPLATE_SOON', 'WA_TEMPLATE_NEXT', 'WA_TEMPLATE_LATER']).filter((k) => !env(k));
}
const configured = () => !!PROVIDER && missing().length === 0;
const status = () => ({ provider: PROVIDER || 'none', ready: configured(), missing: missing() });

// Indian numbers: 98765 43210 / 098765… / +91 98765… / Excel's 9.87654321E9 → 919876543210
function normPhone(p) {
  let s = String(p == null ? '' : p).trim();
  if (/^\d(\.\d+)?e\+?\d+$/i.test(s)) s = Number(s).toFixed(0);
  let d = s.replace(/\.0+$/, '').replace(/[^\d]/g, '');
  if (!d) return '';
  if (d.length === 10) d = '91' + d;
  else if (d.length === 11 && d[0] === '0') d = '91' + d.slice(1);
  return d.length >= 10 && d.length <= 15 ? d : '';
}

// Which messages are due, comparing before → after. `sent[matchId]` = {soon, next, later} timestamps.
function detect(prev, next, sent) {
  const before = new Map((prev ? prev.matches : []).map((m) => [m.id, m]));
  const events = [];
  next.matches.forEach((m, i) => {
    const s = sent[m.id] || {};
    const toldNext = !!s.next && !(s.later && s.later >= s.next); // a "you're next" is currently standing
    const p = before.get(m.id), startedNow = m.status === 'live' && p && p.status === 'queued'; // started straight from the queue just now
    if ((m.status === 'called' || startedNow) && !toldNext) events.push({ kind: 'next', m });
    else if (m.status === 'queued' && toldNext) events.push({ kind: 'later', m });
    else if (m.status === 'queued' && i < BOARD && !s.soon && !s.next) events.push({ kind: 'soon', m });
  });
  return events;
}

function params(kind, m, side) {
  const me = side === 'a' ? m.a : m.b, them = side === 'a' ? m.b : m.a;
  return kind === 'next' ? [me, them, String(m.court || '-')] : [me, them];
}
const PREVIEW = {
  soon: (p) => `Hi ${p[0]}, your match vs ${p[1]} at THE GOAT Badminton Tournament is expected to start in about 30 minutes . Please be at the venue and ready.`,
  next: (p) => `Hi ${p[0]}, your match vs ${p[1]} is NEXT. Please report to court No. ${p[2]}. Good Luck!`,
  later: (p) => `Hi ${p[0]}, sorry for the inconvenience — your match vs ${p[1]} has been moved a little later. We'll message you again when it's your turn.`,
};

// One delivery = one message to one player. `round` = when the event happened (repeat "next"s get a new round).
function makeDelivery(m, kind, side, round, contacts) {
  const c = contacts[m.id] || {}, to = normPhone(c[side]), p = params(kind, m, side);
  return { id: `${m.id}_${kind}_${side}_${round}`, matchId: m.id, kind, side, to: to ? '+' + to : '', name: side === 'a' ? m.a : m.b,
    match: `${m.a} v ${m.b}`, p, text: PREVIEW[kind](p), createdAt: round, attempts: 0, nextAt: round, lastError: '',
    status: to ? 'pending' : 'no number' };
}

// Plan the messages for a change. Returns the "sent" flags to save and the deliveries to queue.
function plan(prev, next, { contacts, sent }, now = Date.now()) {
  const sentPatch = {}, deliveries = [];
  for (const { kind, m } of detect(prev, next, sent)) {
    sentPatch[m.id] = Object.assign({}, sent[m.id] || {}, sentPatch[m.id] || {}, { [kind]: now });
    for (const side of ['a', 'b']) deliveries.push(makeDelivery(m, kind, side, now, contacts));
  }
  return { sentPatch, deliveries };
}

// A number was added (or fixed) for a player who already missed a message that still matters → send it now.
function followUps(st, sent, before, after) {
  const out = [];
  st.matches.forEach((m, i) => {
    const o = before[m.id] || {}, n = after[m.id];
    if (!n) return;
    const s = sent[m.id] || {}, toldNext = !!s.next && !(s.later && s.later >= s.next);
    for (const side of ['a', 'b']) {
      if (!normPhone(n[side]) || normPhone(n[side]) === normPhone(o[side])) continue; // no new number for this side
      if (m.status === 'called' && toldNext) out.push(makeDelivery(m, 'next', side, s.next, after));
      else if (m.status === 'queued' && i < BOARD && s.soon && !s.next) out.push(makeDelivery(m, 'soon', side, s.soon, after));
    }
  });
  return out;
}

// Is this message still worth sending right now?
function stillRelevant(d, st) {
  const m = st.matches.find((x) => x.id === d.matchId);
  if (!m) return false;                                  // finished or deleted
  if (d.kind === 'soon') return m.status === 'queued';   // already called / playing → no "coming up"
  if (d.kind === 'later') return m.status === 'queued';  // called again → a fresh "next" goes instead
  return true;
}

async function deliver(to, kind, p) {
  if (!configured()) return { ok: true, test: true };
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), Number(env('WA_TEST_TIMEOUT_MS')) || 15000);
  try {
    if (PROVIDER === 'gupshup-enterprise') {
      const body = new URLSearchParams({ send_to: to, msg_type: 'text', userid: env('GUPSHUP_USERID'), auth_scheme: 'plain', v: '1.1', format: 'json',
        method: 'SendMessage', isHSM: 'true', isTemplate: p.length ? 'false' : 'true', whatsAppTemplateId: TPL[kind] }); // as in Gupshup's sample
      p.forEach((v, i) => body.append('var' + (i + 1), v)); // {{1}}, {{2}}, {{3}} → var1, var2, var3
      const r = await fetch(GATEWAY, { method: 'POST', signal: ctl.signal,
        headers: { Authorization: 'Bearer ' + env('GUPSHUP_TOKEN'), 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      const text = await r.text();
      let j = {}; try { j = JSON.parse(text); } catch {}
      const resp = j.response || j.data || j;
      return r.ok && String(resp.status || '').toLowerCase() === 'success' ? { ok: true, id: resp.id }
        : { ok: false, error: (resp.details || resp.message || text || 'HTTP ' + r.status).toString().slice(0, 200) };
    }
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
  } catch (e) { return { ok: false, error: e.name === 'AbortError' ? 'no answer from Gupshup (timed out)' : e.message }; }
  finally { clearTimeout(timer); }
}

// One attempt for one delivery; updates and returns it.
async function attempt(d) {
  const r = await deliver(d.to.replace('+', ''), d.kind, d.p);
  const now = Date.now();
  d.attempts = (d.attempts || 0) + 1;
  d.lastAttemptAt = now;
  if (r.test) { d.status = 'test (not sent)'; return d; }
  if (r.ok) { d.status = 'sent'; d.sentAt = now; d.providerId = r.id || ''; return d; }
  d.lastError = r.error;
  if (d.attempts >= MAX_ATTEMPTS) { d.status = 'failed'; return d; }
  d.status = 'pending'; d.nextAt = now + BACKOFF[d.attempts];
  return d;
}

// Send everything that is due, 3 at a time (so Gupshup isn't flooded), within a time budget.
// `claim(d)` (optional) makes sure two servers never send the same delivery at once.
async function processDue(items, st, { claim, budgetMs = 20000 } = {}) {
  const started = Date.now(), now = started;
  const due = items.filter((d) => d.status === 'pending' && (d.nextAt || 0) <= now).sort((a, b) => (a.nextAt || 0) - (b.nextAt || 0));
  const done = [];
  let i = 0;
  async function worker() {
    while (i < due.length && Date.now() - started < budgetMs) {
      const d = due[i++];
      if (!stillRelevant(d, st)) { d.status = 'skipped (no longer needed)'; done.push(d); continue; }
      if (claim && !(await claim(d))) continue;
      done.push(await attempt(d));
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return done;
}

// One real message to check the setup (Control Room → WhatsApp → Send test).
async function testSend(phone, kind = 'next') {
  const to = normPhone(phone);
  if (!to) return { ok: false, error: 'Enter a valid mobile number' };
  if (!configured()) return { ok: false, error: 'Not set up yet. Missing in Vercel: ' + missing().join(', ') + ' — add them, then Redeploy' };
  const p = kind === 'next' ? ['Test Player', 'Sample Opponent', '1'] : ['Test Player', 'Sample Opponent'];
  const r = await deliver(to, kind, p);
  return Object.assign({ to: '+' + to, text: PREVIEW[kind](p) }, r);
}

module.exports = { plan, followUps, processDue, stillRelevant, detect, normPhone, status, configured, PREVIEW, testSend, MAX_ATTEMPTS };
