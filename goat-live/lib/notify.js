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
// Indian mobile numbers: 98765 43210 · 098765 43210 · 91 98765 43210 · +91 98765 43210 (also Excel's 9.19877E+11).
// Another country only when written with + or 00 in front. Anything else is a typo → '' (never guessed as a foreign number).
function normPhone(p) {
  let s = String(p == null ? '' : p).trim();
  if (/^\d(\.\d+)?e\+?\d+$/i.test(s)) s = Number(s).toFixed(0);
  s = s.replace(/\.0+$/, '');
  const intl = /^(\+|00)/.test(s);
  let d = s.replace(/[^\d]/g, '');
  if (!d) return '';
  if (intl) { if (s.startsWith('00')) d = d.slice(2); return d.length >= 10 && d.length <= 15 ? d : ''; }
  if (d.length === 11 && d[0] === '0') d = d.slice(1);
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  return /^[6-9]\d{9}$/.test(d) ? '91' + d : '';
}

// Which messages are due, comparing before → after. `sent[matchId]` = {soon, next, later} timestamps.
// "Coming up" goes when the match is expected within SOON_MIN minutes (or is in the board's top 10 without a time).
// Knockout matches whose players aren't known yet get nothing until they are.
const SOON_MIN = 35;
const soonDue = (m, i, now) => (m.time ? m.time - now <= SOON_MIN * 60000 : i < BOARD);
function detect(prev, next, sent, now = Date.now()) {
  const before = new Map((prev ? prev.matches : []).map((m) => [m.id, m]));
  const events = [];
  next.matches.forEach((m, i) => {
    if (!m.a || !m.b) return;
    if (m.hold && m.status === 'queued' && !(sent[m.id] && sent[m.id].next)) return; // not in the order of play (top 10) yet
    const s = sent[m.id] || {};
    const toldNext = !!s.next && !(s.later && s.later >= s.next); // a "you're next" is currently standing
    const p = before.get(m.id), startedNow = m.status === 'live' && p && p.status === 'queued'; // started straight from the queue just now
    const beReady = m.status === 'queued' && !!m.ready; // the court's match is finishing → "BE READY · COURT N" (automatic)
    if ((m.status === 'called' || startedNow || beReady) && !toldNext) events.push({ kind: 'next', m });
    else if (m.status === 'queued' && !m.ready && toldNext) events.push({ kind: 'later', m });
    else if (m.status === 'queued' && soonDue(m, i, now) && !s.soon && !s.next) events.push({ kind: 'soon', m });
  });
  return events;
}

function params(kind, m, side) {
  const me = side === 'a' ? m.a : m.b, them = side === 'a' ? m.b : m.a;
  return kind === 'next' ? [me, them, String(m.court || m.readyCourt || '-')] : [me, them];
}
const PREVIEW = {
  soon: (p) => `Hi ${p[0]}, your match vs ${p[1]} at THE GOAT Badminton Tournament is expected to start in about 30 minutes . Please be at the venue and ready.`,
  next: (p) => `Hi ${p[0]}, your match vs ${p[1]} is NEXT. Please report to court No. ${p[2]}. Good Luck!`,
  later: (p) => `Hi ${p[0]}, sorry for the inconvenience — your match vs ${p[1]} has been moved a little later. We'll message you again when it's your turn.`,
};

// One delivery = one message to one player. `round` = when the event happened (repeat "next"s get a new round).
function makeDelivery(m, kind, side, round, contacts) {
  const c = contacts[m.id] || {}, to = normPhone(c[side]), p = params(kind, m, side), typed = String(c[side] == null ? '' : c[side]).trim();
  return { id: `${m.id}_${kind}_${side}_${round}`, matchId: m.id, kind, side, to: to ? '+' + to : '', name: side === 'a' ? m.a : m.b,
    match: `${m.a} v ${m.b}`, p, text: PREVIEW[kind](p), createdAt: round, attempts: 0, nextAt: round,
    status: to ? 'pending' : typed ? 'wrong number' : 'no number',
    lastError: !to && typed ? `"${typed}" is not a valid mobile number — fix it in the match` : '' };
}

// Plan the messages for a change. Returns the "sent" flags to save and the deliveries to queue.
function plan(prev, next, { contacts, sent }, now = Date.now()) {
  const sentPatch = {}, deliveries = [];
  for (const { kind, m } of detect(prev, next, sent, now)) {
    sentPatch[m.id] = Object.assign({}, sent[m.id] || {}, sentPatch[m.id] || {}, { [kind]: now });
    for (const side of ['a', 'b']) deliveries.push(makeDelivery(m, kind, side, now, contacts));
  }
  return { sentPatch, deliveries };
}

// A number was added (or fixed) for a player who already missed a message that still matters → send it now.
function followUps(st, sent, before, after) {
  const out = [];
  st.matches.forEach((m, i) => {
    if (!m.a || !m.b || (m.hold && m.status === 'queued')) return;
    const o = before[m.id] || {}, n = after[m.id];
    if (!n) return;
    const s = sent[m.id] || {}, toldNext = !!s.next && !(s.later && s.later >= s.next);
    for (const side of ['a', 'b']) {
      if (!normPhone(n[side]) || normPhone(n[side]) === normPhone(o[side])) continue; // no new number for this side
      if (m.status === 'called' && toldNext) out.push(makeDelivery(m, 'next', side, s.next, after));
      else if (m.status === 'queued' && s.soon && !s.next) out.push(makeDelivery(m, 'soon', side, s.soon, after));
    }
  });
  return out;
}

// Is this message still worth sending right now?
function stillRelevant(d, st) {
  const m = st.matches.find((x) => x.id === d.matchId);
  if (!m) return false;                                  // finished or deleted
  if (d.kind === 'soon') return m.status === 'queued' && !m.hold;   // already called / playing → no "coming up"
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
  // errors that trying again can't fix (bad number, country not enabled, …) → call list straight away
  const hopeless = /INTERNATIONAL_PHONE|service is disabled|invalid destination|not a valid (mobile|phone)|invalid (mobile|phone)/i.test(r.error || '');
  if (hopeless || d.attempts >= MAX_ATTEMPTS) { d.status = 'failed'; return d; }
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

// ── Delivery reports (Gupshup → our webhook) ──
// "Accepted" by Gupshup ≠ delivered. WhatsApp reports later: sent / delivered / read / failed (+ reason).
// Meta error codes that are temporary (worth retrying); anything else is permanent → call the player.
const TEMPORARY = new Set([130429, 131000, 131016, 131048, 131056, 133004, 133010, 2]);
// Errors that will fail every time (template / parameter / not-allowed problems) → call list straight away.
const HOPELESS = new Set([100, 131008, 131009, 131021, 131030, 131051, 132000, 132001, 132005, 132007, 132012, 132015, 132016, 132068, 132069]);
const REPORT_RETRIES = 2;            // other failures (e.g. 131026 undeliverable): send again this many times, then call
const CONFIRM_MS = 10 * 60e3 * SCALE;        // no 'delivered' within this → send once more, then call
// Accept both payload styles offered in Gupshup's webhook settings (Meta v3 and Gupshup v2), plus older flat formats.
function parseReports(body) {
  const out = [], push = (e) => { if (e.status) out.push(e); };
  const one = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(one);
    // Meta format (v3): entry[].changes[].value.statuses[]
    if (o.entry) return (o.entry || []).forEach((en) => (en.changes || []).forEach((ch) => ((ch.value && ch.value.statuses) || []).forEach((s) => {
      const err = (s.errors && s.errors[0]) || {};
      push({ ids: [s.id, s.gs_id, s.meta_msg_id].filter(Boolean), phone: s.recipient_id, status: String(s.status || '').toLowerCase(),
        code: Number(err.code) || 0, reason: [err.title, err.error_data && err.error_data.details, err.message].filter(Boolean).join(' — '), at: Number(s.timestamp) * 1000 || Date.now() });
    })));
    // Gupshup format (v2): { type: 'message-event', payload: { id, gsId, type, destination, payload: { code, reason } } }
    if (o.type === 'message-event' && o.payload) {
      const p = o.payload, inner = p.payload || {};
      return push({ ids: [p.id, p.gsId, p.messageId].filter(Boolean), phone: p.destination, status: String(p.type || '').toLowerCase(),
        code: Number(inner.code) || 0, reason: inner.reason || '', at: Number(o.timestamp) || Date.now() });
    }
    // older flat delivery-report formats (externalId / phoneNo / status / cause …)
    const st = o.status || o.eventType || o.event || o.deliveryStatus;
    if (o.response && typeof o.response === 'object') return one(o.response);
    if (st && (o.phoneNo || o.destAddr || o.destination || o.phone || o.recipient || o.recipient_id || o.externalId || o.messageId)) {
      let s = String(st).toLowerCase();
      if (/^(success|delivrd|delivered)$/.test(s)) s = 'delivered'; else if (/^(read|seen)$/.test(s)) s = 'read'; else if (/^(sent|submitted|enqueued)$/.test(s)) s = 'sent'; else if (/fail|undeliv|reject|expired|error/.test(s)) s = 'failed';
      const t = Number(o.eventTs || o.deliveredTS || o.timestamp) || 0;
      push({ ids: [o.externalId, o.id, o.messageId, o.gsId, o.extra].filter(Boolean).map(String), phone: o.phoneNo || o.destAddr || o.destination || o.phone || o.recipient || o.recipient_id,
        status: s, code: Number(o.errorCode || o.errCode || o.code) || 0, reason: o.cause || o.reason || o.description || '', at: t ? (t < 1e12 ? t * 1000 : t) : Date.now() });
    }
  };
  one(body);
  return out;
}
const RANK = { sent: 1, delivered: 2, read: 3 };
// Apply reports to recent deliveries. Returns the deliveries that changed.
function applyReports(reports, recent, now = Date.now(), { idOnly = false } = {}) {
  const changed = new Map();
  for (const r of reports) {
    const phone = normPhone(r.phone);
    // 1) exact message id  2) otherwise the latest message to that number in the last 6 hours
    let d = recent.find((x) => x.providerId && r.ids.includes(String(x.providerId)));
    if (!d && phone && !idOnly) d = recent.filter((x) => x.to === '+' + phone && (x.sentAt || 0) > now - 6 * 3600e3 && (x.sentAt || 0) <= (r.at || now) + 120e3)
      .sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0))[0];
    if (!d || d.status !== 'sent') continue;
    if (r.status === 'failed') {
      d.lastError = (r.code ? `WhatsApp ${r.code}: ` : 'WhatsApp: ') + (r.reason || 'not delivered');
      d.delivery = 'failed';
      d.reportFails = (d.reportFails || 0) + 1;
      const again = (d.attempts || 0) < MAX_ATTEMPTS && !HOPELESS.has(r.code) && (TEMPORARY.has(r.code) || d.reportFails <= REPORT_RETRIES);
      if (again) { d.status = 'pending'; d.delivery = ''; d.nextAt = now + BACKOFF[Math.min(d.attempts || 1, BACKOFF.length - 1)]; }
      else d.status = 'failed'; // can't get through → "call these players"
      changed.set(d.id, d);
    } else if (RANK[r.status] && RANK[r.status] > (RANK[d.delivery] || 0)) {
      d.delivery = r.status; d.deliveryAt = r.at || now;
      changed.set(d.id, d);
    }
  }
  return [...changed.values()];
}

// Messages Gupshup accepted but WhatsApp never confirmed. Only used while delivery reports are known to be working.
// Returns { resend: [...], fail: [...], drop: [ids] }.
function checkUnconfirmed(watch, st, now = Date.now()) {
  const out = { resend: [], fail: [], drop: [] };
  for (const d of watch) {
    const age = now - (d.sentAt || now);
    if (d.delivery === 'delivered' || d.delivery === 'read') { if (now - (d.deliveryAt || now) > 30 * 60e3 || d.delivery === 'read') out.drop.push(d.id); continue; }
    if (age > 6 * 3600e3 || !stillRelevant(d, st)) { out.drop.push(d.id); continue; }
    if (age < CONFIRM_MS) continue;
    if (!d.resent && (d.attempts || 0) < MAX_ATTEMPTS) {
      out.resend.push(Object.assign(d, { status: 'pending', resent: 1, nextAt: now, delivery: '', lastError: 'no delivery confirmation in 10 min — sending again' }));
    } else out.fail.push(Object.assign(d, { status: 'failed', lastError: 'not delivered (no confirmation from WhatsApp) — phone may be off or not on WhatsApp' }));
  }
  return out;
}

// A pop-up for the Control Room: delivered / sent / retry (failed, trying again) / call (gave up → phone them).
function pop(d, status) {
  return { at: Date.now(), status, name: d.name || '', to: d.to || '', kind: d.kind || '', match: d.match || '', why: d.lastError || '' };
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

module.exports = { plan, followUps, processDue, stillRelevant, detect, normPhone, status, configured, PREVIEW, testSend, MAX_ATTEMPTS, parseReports, applyReports, checkUnconfirmed, pop };
