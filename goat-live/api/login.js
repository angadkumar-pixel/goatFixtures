// POST /api/login { password } → sets the admin cookie. 5 wrong tries per address → 10-minute lockout.
const store = require('../lib/store');
const auth = require('../lib/auth');
const { PASSWORD, SECRET, json, fail, isHttps, clientIp, body } = require('../lib/http');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!PASSWORD) return json(res, 500, { error: 'ADMIN_PASSWORD is not set in Vercel → Settings → Environment Variables.' });
  try {
    const ip = clientIp(req);
    if ((await store.failCount(ip)) >= 5) return json(res, 429, { error: 'Too many attempts. Wait 10 minutes.' });
    const { password } = await body(req);
    if (!auth.passwordOk(password, PASSWORD)) { await store.failCount(ip, true); return json(res, 401, { error: 'Wrong password' }); }
    await store.clearFails(ip);
    res.setHeader('Set-Cookie', auth.makeCookie(SECRET, isHttps(req)));
    json(res, 200, { ok: true });
  } catch (e) { fail(res, e); }
};
