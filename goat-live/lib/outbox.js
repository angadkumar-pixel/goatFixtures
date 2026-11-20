// Online (Vercel + Firebase): private phone numbers + a reliable WhatsApp delivery queue.
//   goat_private/contacts/<matchId>  phone numbers          goat_private/sent/<matchId>   which messages a match has had
//   goat_private/queue/<deliveryId>  waiting / retrying      goat_private/failed/<id>      gave up after 10 tries → call them
//   goat_private/log/<time_id>       latest status of every delivery (shown in the Control Room)
const fire = require('./fire');
const notify = require('./notify');
const shared = require('../public/js/goat-shared');

const logKey = (d) => `${d.createdAt}_${d.id}`;
const copy = (x) => JSON.parse(JSON.stringify(x));
const norm = (st) => shared.normalize(copy(st), Date.now());

// Save phone numbers that came with this change. Returns the numbers before/after so newly added ones can be followed up.
async function saveContacts(st) {
  const patch = {};
  st.matches.concat(st.done).forEach((m) => { if (m.contact) patch[m.id] = m.contact; });
  const before = (await fire.get('goat_private/contacts')) || {};
  if (Object.keys(patch).length) await fire.patch('goat_private/contacts', patch);
  return { before, after: Object.assign({}, before, patch), changed: Object.keys(patch).length > 0 };
}

// After a change: queue every message that's due (one per player), then start sending. Never throws.
async function afterChange(prev, next, contactsInfo) {
  try {
    if (!next.settings || !next.settings.notify) return { queued: 0 };
    const sent = (await fire.get('goat_private/sent')) || {};
    const b = norm(next);
    const { sentPatch, deliveries } = notify.plan(norm(prev), b, { contacts: contactsInfo.after, sent });
    const follow = contactsInfo.changed ? notify.followUps(b, Object.assign({}, sent, sentPatch), contactsInfo.before, contactsInfo.after) : [];
    const ids = new Set(deliveries.map((d) => d.id));
    const all = deliveries.concat(follow.filter((d) => !ids.has(d.id))), writes = {}; // follow-ups only for messages not already planned
    all.forEach((d) => { writes[(d.status === 'pending' ? 'queue/' + d.id : 'log/' + logKey(d))] = d; });
    Object.keys(sentPatch).forEach((id) => { writes['sent/' + id] = sentPatch[id]; });
    if (Object.keys(writes).length) await fire.patch('goat_private', writes);
    const r = all.some((d) => d.status === 'pending') ? await processQueue(b, 12000) : {};
    return Object.assign({ queued: all.length }, r);
  } catch (e) { console.error('whatsapp', e); return { queued: 0, error: e.message }; }
}

// Only one server may send a given delivery at a time (compare-and-set lock on the queue entry).
async function claim(d) {
  const cur = await fire.req('GET', 'goat_private/queue/' + d.id, { headers: { 'X-Firebase-ETag': 'true' } });
  if (!cur.data || cur.data.status !== 'pending' || (cur.data.lockUntil || 0) > Date.now()) return false;
  const r = await fire.req('PUT', 'goat_private/queue/' + d.id, { body: Object.assign({}, cur.data, { lockUntil: Date.now() + 60000 }), headers: { 'if-match': cur.etag } });
  return r.status === 200;
}

// Send whatever is due now (new messages and retries). Called after changes and every ~20 s by the Control Room.
async function processQueue(st, budgetMs = 20000) {
  const q = (await fire.get('goat_private/queue')) || {};
  const items = Object.values(q);
  if (!items.length) return { processed: 0, pending: 0 };
  if (!st) st = norm((await fire.load()).st);
  const done = await notify.processDue(items, st, { claim, budgetMs });
  const writes = {};
  for (const d of done) {
    delete d.lockUntil;
    writes['log/' + logKey(d)] = d;
    if (d.status === 'pending') writes['queue/' + d.id] = d;               // will retry later
    else {
      writes['queue/' + d.id] = null;                                      // finished: sent / skipped / failed
      if (d.status === 'failed') writes['failed/' + d.id] = d;             // → "call these players"
    }
  }
  if (Object.keys(writes).length) await fire.patch('goat_private', writes);
  return { processed: done.length, pending: items.length - done.filter((d) => d.status !== 'pending').length };
}

// Control Room buttons on a failed delivery: try again from scratch, or mark it handled (called by phone).
async function failedAction(id, action) {
  const d = await fire.get('goat_private/failed/' + id);
  if (!d) return { ok: false, error: 'Not found' };
  if (action === 'done') { await fire.patch('goat_private', { ['failed/' + id]: null }); return { ok: true }; }
  Object.assign(d, { status: 'pending', attempts: 0, nextAt: Date.now(), lastError: '' });
  await fire.patch('goat_private', { ['failed/' + id]: null, ['queue/' + id]: d, ['log/' + logKey(d)]: d });
  return Object.assign({ ok: true }, await processQueue(null, 15000));
}

async function adminData() {
  const [contacts, logAll, failed, queue] = await Promise.all([
    fire.get('goat_private/contacts'),
    fire.get('goat_private/log', `&orderBy=${encodeURIComponent('"$key"')}&limitToLast=150`),
    fire.get('goat_private/failed'),
    fire.get('goat_private/queue', '&shallow=true'),
  ]);
  const log = Object.keys(logAll || {}).sort().reverse().map((k) => logAll[k]);
  return { contacts: contacts || {}, log, failed: Object.values(failed || {}).sort((a, b) => b.lastAttemptAt - a.lastAttemptAt), pending: Object.keys(queue || {}).length };
}

module.exports = { saveContacts, afterChange, processQueue, failedAction, adminData };
