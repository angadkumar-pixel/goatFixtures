// POST /api/tick → if a "starts in mm:ss" countdown has reached 0, put that match LIVE.
// Screens call this when they see a countdown end (Vercel has no background timers). Safe to call many times.
// Automatic changes go through the same WhatsApp step as manual ones, so no message is ever skipped.
const fire = require('../lib/fire');
const core = require('../lib/core');
const outbox = require('../lib/outbox');
const { json, fail } = require('../lib/http');

module.exports = async (req, res) => {
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { tree, st } = await fire.load();
      const prev = JSON.parse(JSON.stringify(st));
      if (!core.autoStart(st, Date.now())) return json(res, 200, { changed: false });
      if (await fire.commit(tree, st, st.rev - 0)) {
        const contacts = (await fire.get('goat_private/contacts')) || {};
        const whatsapp = await outbox.afterChange(prev, st, { before: contacts, after: contacts, changed: false });
        return json(res, 200, { changed: true, whatsapp });
      }
    }
    json(res, 200, { changed: false });
  } catch (e) { fail(res, e); }
};
