// POST /api/tick → if a "starts in mm:ss" countdown has reached 0, put that match LIVE.
// Screens call this when they see a countdown end (Vercel has no background timers). Safe to call many times.
const fire = require('../lib/fire');
const core = require('../lib/core');
const { json, fail } = require('../lib/http');

module.exports = async (req, res) => {
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { tree, st } = await fire.load();
      if (!core.autoStart(st, Date.now())) return json(res, 200, { changed: false });
      if (await fire.commit(tree, st, st.rev - 0)) return json(res, 200, { changed: true });
    }
    json(res, 200, { changed: false });
  } catch (e) { fail(res, e); }
};
