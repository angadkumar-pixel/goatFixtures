const auth = require('../lib/auth');
const { json } = require('../lib/http');

module.exports = (req, res) => { res.setHeader('Set-Cookie', auth.clearCookie()); json(res, 200, { ok: true }); };
