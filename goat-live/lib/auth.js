// Admin login: a signed, expiring cookie (no sessions to store). Shared by server.js and api/*.js.
const crypto = require('crypto');

const COOKIE = 'goat_admin';
const sign = (secret, v) => crypto.createHmac('sha256', secret).update(v).digest('base64url');
function makeCookie(secret, secure) {
  const exp = String(Date.now() + 1000 * 60 * 60 * 24);
  return `${COOKIE}=${exp}.${sign(secret, exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secure ? '; Secure' : ''}`;
}
const clearCookie = () => `${COOKIE}=; Path=/; Max-Age=0`;
function isAdmin(cookieHeader, secret) {
  const c = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookieHeader || '');
  if (!c) return false;
  const [exp, sig] = c[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(secret, exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function passwordOk(given, password) {
  const h = (s) => crypto.createHash('sha256').update(String(s || '')).digest();
  return crypto.timingSafeEqual(h(given), h(password));
}
module.exports = { makeCookie, clearCookie, isAdmin, passwordOk };
