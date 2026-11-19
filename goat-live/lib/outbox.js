// Online (Vercel + Firebase): keep phone numbers private and send WhatsApp messages after a change.
const fire = require('./fire');
const notify = require('./notify');
const shared = require('../public/js/goat-shared');

// Save phone numbers that came with this change (new matches, edits) to the private area.
async function saveContacts(st) {
  const patch = {};
  st.matches.concat(st.done).forEach((m) => { if (m.contact) patch[m.id] = m.contact; });
  if (Object.keys(patch).length) await fire.patch('goat_private/contacts', patch);
}
// Work out who needs a message (before → after) and send it. Never throws: messaging must not block the tournament.
async function sendMessages(prev, next) {
  try {
    if (!next.settings || !next.settings.notify) return [];
    const [contacts, sent] = await Promise.all([fire.get('goat_private/contacts'), fire.get('goat_private/sent')]);
    const a = shared.normalize(JSON.parse(JSON.stringify(prev)), Date.now());
    const b = shared.normalize(JSON.parse(JSON.stringify(next)), Date.now());
    const { sentPatch, log } = await notify.run(a, b, { contacts: contacts || {}, sent: sent || {}, enabled: true });
    const writes = [];
    if (Object.keys(sentPatch).length) writes.push(fire.patch('goat_private/sent', sentPatch));
    if (log.length) writes.push(fire.patch('goat_private/log', Object.fromEntries(log.map((e, i) => [String(e.at) + '_' + String(i).padStart(3, '0'), e]))));
    await Promise.all(writes);
    return log;
  } catch (e) { console.error('whatsapp', e); return []; }
}
async function recentLog(n = 150) {
  const all = (await fire.get('goat_private/log', `&orderBy=${encodeURIComponent('"$key"')}&limitToLast=${n}`)) || {};
  return Object.keys(all).sort().reverse().map((k) => all[k]);
}
module.exports = { saveContacts, sendMessages, recentLog };
