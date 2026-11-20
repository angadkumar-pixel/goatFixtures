// GET /api/time  → server clock, so every screen's countdowns agree even if a phone's clock is off.
// GET /api/board → (rewritten here as ?board=1) the public fixtures for spectators' phones, cached by the CDN for a
//   few seconds: hundreds of phones cost a handful of database reads and no Firebase connections (the free Firebase
//   plan allows 100 at once — kept for the TVs and the Control Room). No phone numbers are in there.
// (One file for both: the Vercel Hobby plan allows 12 functions.)
const fire = require('../lib/fire');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!(req.query && req.query.board)) { res.setHeader('Cache-Control', 'no-store'); return res.end(JSON.stringify({ now: Date.now() })); }
  try {
    const tree = (await fire.get('goat')) || {};
    res.statusCode = 200;
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=4, stale-while-revalidate=20');
    res.end(JSON.stringify(tree));
  } catch (e) {
    res.statusCode = 503; res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: e.message }));
  }
};
