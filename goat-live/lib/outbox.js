// Online (Vercel + Firebase): private phone numbers + a reliable WhatsApp delivery queue.
//   goat_private/contacts/<matchId>  phone numbers          goat_private/sent/<matchId>   which messages a match has had
//   goat_private/queue/<deliveryId>  waiting / retrying      goat_private/failed/<id>      gave up after 10 tries → call them
//   goat_private/log/<time_id>       latest status of every delivery (shown in the Control Room)
//   goat_private/watch/<id>          accepted by Gupshup, waiting for WhatsApp's 'delivered' report
const fire = require('./fire');
const notify = require('./notify');
const shared = require('../public/js/goat-shared');

const logKey = (d) => `${d.createdAt}_${d.id}`;
let popSeq = 0;
const pop = (writes, d, status) => { writes['events/' + Date.now() + '_' + (popSeq++ % 1000) + '_' + status + '_' + d.id] = notify.pop(d, status); }; // pop-up in the Control Room
const reportsWorking = async () => { const ok = await fire.get('goat_private/hook_ok'); return !!ok && Date.now() - ok < 2 * 3600e3; };
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
  await checkWatch(st).catch((e) => console.error('watch', e));
  const q = (await fire.get('goat_private/queue')) || {};
  const items = Object.values(q);
  if (!items.length) return { processed: 0, pending: 0 };
  if (!st) st = norm((await fire.load()).st);
  const done = await notify.processDue(items, st, { claim, budgetMs });
  const writes = {}, reports = done.some((d) => d.status === 'sent') ? await reportsWorking() : true;
  for (const d of done) {
    delete d.lockUntil;
    writes['log/' + logKey(d)] = d;
    if (d.status === 'sent') writes['watch/' + d.id] = d;                 // wait for WhatsApp to confirm
    if (d.status === 'sent' && !reports) pop(writes, d, 'sent');          // no delivery reports → at least say it went out
    if (d.status === 'pending' && d.attempts === 1) pop(writes, d, 'retry');
    if (d.status === 'failed') pop(writes, d, 'call');
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
  Object.assign(d, { status: 'pending', attempts: 0, reportFails: 0, resent: 0, delivery: '', nextAt: Date.now(), lastError: '' });
  await fire.patch('goat_private', { ['failed/' + id]: null, ['queue/' + id]: d, ['log/' + logKey(d)]: d });
  return Object.assign({ ok: true }, await processQueue(null, 15000));
}

// Delivery reports from Gupshup (every report is processed): mark delivered / read, resend failures automatically,
// and only when it still can't get through put the player on the call list.
async function handleReports(payload, method = 'POST') {
  const reports = notify.parseReports(payload);
  const hook = { at: Date.now(), reports: reports.length, matched: 0, sample: JSON.stringify(payload || {}).slice(0, 1500), method };
  if (!reports.length) { await fire.patch('goat_private', { hook_last: hook }); return { matched: 0 }; }
  const watch = (await fire.get('goat_private/watch')) || {};
  const was = {}; Object.values(watch).forEach((w) => { if (w && w.id) was[w.id] = w.delivery || ''; });
  const changed = notify.applyReports(reports, Object.values(watch));
  const writes = { hook_last: Object.assign(hook, { matched: changed.length }) };
  if (changed.length) writes.hook_ok = hook.at;                       // reports are working → the watchdog may act
  for (const d of changed) {
    const k = 'log/' + logKey(d);
    const seen = was[d.id] === 'delivered' || was[d.id] === 'read';
    if (d.status === 'sent' && !seen && (d.delivery === 'delivered' || d.delivery === 'read')) pop(writes, d, 'delivered');
    if (d.status === 'pending') pop(writes, d, 'retry');
    if (d.status === 'failed') pop(writes, d, 'call');
    if (d.status === 'sent') {                                          // delivered / read: touch only those fields
      writes[k + '/delivery'] = d.delivery; writes[k + '/deliveryAt'] = d.deliveryAt;
      if (d.delivery === 'read') writes['watch/' + d.id] = null;
      else { writes['watch/' + d.id + '/delivery'] = d.delivery; writes['watch/' + d.id + '/deliveryAt'] = d.deliveryAt; }
    } else {
      writes[k] = d; writes['watch/' + d.id] = null;
      if (d.status === 'pending') writes['queue/' + d.id] = d;          // failed → send again
      if (d.status === 'failed') writes['failed/' + d.id] = d;          // still can't get through → call
    }
  }
  await fire.patch('goat_private', writes);
  if (changed.some((d) => d.status === 'pending')) await processQueue(null, 8000).catch(() => {}); // resend right away when due
  return { reports: reports.length, matched: changed.length };
}

// Accepted but never confirmed → send once more, then call. Only while reports are arriving (else we'd resend everything).
async function checkWatch(st) {
  const [watch, ok] = await Promise.all([fire.get('goat_private/watch'), fire.get('goat_private/hook_ok')]);
  const list = Object.entries(watch || {}).map(([id, v]) => Object.assign({ id }, v)); // id from the key (safe even for half-written entries)
  const working = ok && Date.now() - ok < 2 * 3600e3;
  const writes = {};
  if (list.length) { if (!st) st = norm((await fire.load()).st); }
  const r = list.length ? notify.checkUnconfirmed(list, st) : { drop: [], resend: [], fail: [] };
  r.drop.forEach((id) => { writes['watch/' + id] = null; });
  if (working) {
    r.resend.forEach((d) => { writes['watch/' + d.id] = null; writes['queue/' + d.id] = d; writes['log/' + logKey(d)] = d; pop(writes, d, 'retry'); });
    r.fail.forEach((d) => { writes['watch/' + d.id] = null; writes['failed/' + d.id] = d; writes['log/' + logKey(d)] = d; pop(writes, d, 'call'); });
  }
  // forget pop-ups older than an hour
  const old = (await fire.get('goat_private/events', `&orderBy=${encodeURIComponent('"$key"')}&endAt=${encodeURIComponent('"' + (Date.now() - 3600e3) + '"')}&limitToFirst=300`)) || {};
  const cutoff = Date.now() - 3600e3;
  Object.keys(old).forEach((k) => { if (Number(k.split('_')[0]) < cutoff) writes['events/' + k] = null; }); // double-check the age ourselves
  if (Object.keys(writes).length) await fire.patch('goat_private', writes);
}

// Pop-ups since a moment (Control Room polls this every few seconds; usually empty).
async function events(since) {
  const ev = (await fire.get('goat_private/events', `&orderBy=${encodeURIComponent('"$key"')}&startAt=${encodeURIComponent('"' + (since + 1) + '"')}&limitToFirst=60`)) || {};
  return Object.keys(ev).filter((k) => Number(k.split('_')[0]) > since).sort().map((k) => ev[k]);
}

async function adminData() {
  const [contacts, logAll, failed, queue, hook, hookOk, rejected] = await Promise.all([
    fire.get('goat_private/contacts'),
    fire.get('goat_private/log', `&orderBy=${encodeURIComponent('"$key"')}&limitToLast=150`),
    fire.get('goat_private/failed'),
    fire.get('goat_private/queue', '&shallow=true'),
    fire.get('goat_private/hook_last'),
    fire.get('goat_private/hook_ok'),
    fire.get('goat_private/hook_rejected'),
  ]);
  const log = Object.keys(logAll || {}).sort().reverse().map((k) => logAll[k]);
  return { contacts: contacts || {}, log, failed: Object.values(failed || {}).sort((a, b) => b.lastAttemptAt - a.lastAttemptAt),
    pending: Object.keys(queue || {}).length, lastReport: hook ? hook.at : null, hook: hook || null, hookOk: hookOk || null, hookRejected: rejected || null };
}

module.exports = { saveContacts, afterChange, processQueue, failedAction, adminData, handleReports, events };
