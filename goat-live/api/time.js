// GET /api/time → server clock, so every screen's countdowns agree even if a phone's clock is off.
module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ now: Date.now() }));
};
