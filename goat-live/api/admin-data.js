// GET /api/admin-data (admin only) → phone numbers, WhatsApp status, the message log and who couldn't be reached.
const outbox = require('../lib/outbox');
const notify = require('../lib/notify');
const auth = require('../lib/auth');
const { SECRET, json, fail } = require('../lib/http');

module.exports = async (req, res) => {
  if (!auth.isAdmin(req.headers.cookie, SECRET)) return json(res, 401, { error: 'Not logged in' });
  try { json(res, 200, Object.assign(await outbox.adminData(), { whatsapp: notify.status() })); }
  catch (e) { fail(res, e); }
};
