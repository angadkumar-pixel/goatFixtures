// GET /api/admin-data (admin only) → phone numbers, WhatsApp status and the message log for the Control Room.
const fire = require('../lib/fire');
const outbox = require('../lib/outbox');
const notify = require('../lib/notify');
const auth = require('../lib/auth');
const { SECRET, json, fail } = require('../lib/http');

module.exports = async (req, res) => {
  if (!auth.isAdmin(req.headers.cookie, SECRET)) return json(res, 401, { error: 'Not logged in' });
  try {
    const [contacts, log] = await Promise.all([fire.get('goat_private/contacts'), outbox.recentLog()]);
    json(res, 200, { contacts: contacts || {}, log, whatsapp: notify.status() });
  } catch (e) { fail(res, e); }
};
