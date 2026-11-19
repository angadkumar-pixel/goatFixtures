// Cloud storage for the Vercel version: Upstash Redis over its REST API (plain fetch, no packages).
// Vercel → Storage → "Upstash for Redis" adds KV_REST_API_URL / KV_REST_API_TOKEN to the project automatically.
const core = require('./core');

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const K = { state: 'goat:state', rev: 'goat:rev', hist: 'goat:hist', due: 'goat:due' };
const configured = () => !!(URL_ && TOKEN);

async function call(path, body) {
  if (!configured()) throw new Error('Database not connected: in Vercel open Storage → add "Upstash for Redis" to this project, then redeploy.');
  const r = await fetch(URL_ + path, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok && j && j.error) throw new Error(j.error);
  return j;
}
const redis = async (cmd) => { const j = await call('', cmd); if (j.error) throw new Error(j.error); return j.result; };
const pipe = async (cmds) => (await call('/pipeline', cmds)).map((x) => { if (x.error) throw new Error(x.error); return x.result; });

// Tiny read used every ~1.5 s by every screen: current revision + when the next countdown ends.
async function head() {
  const [rev, due] = await pipe([['GET', K.rev], ['GET', K.due]]);
  return { rev: Number(rev) || 0, due: due ? Number(due) : null };
}
async function load() {
  const [s, len, rev] = await pipe([['GET', K.state], ['LLEN', K.hist], ['GET', K.rev]]);
  const st = core.migrate(s ? JSON.parse(s) : core.newState());
  st.rev = Number(rev) || 0;
  return { st, histLen: Number(len) || 0 };
}
async function lastSnapshot() { const s = await redis(['LINDEX', K.hist, 0]); return s ? core.migrate(JSON.parse(s)) : null; }

// Save only if nobody else saved since we read (compare-and-set on the revision), atomically, in one round trip.
const CAS = `
if (redis.call('GET', KEYS[1]) or '0') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[3]); redis.call('SET', KEYS[1], ARGV[2]); redis.call('SET', KEYS[4], ARGV[6])
if ARGV[4] ~= '' then redis.call('LPUSH', KEYS[3], ARGV[4]); redis.call('LTRIM', KEYS[3], 0, 24) end
if ARGV[5] == '1' then redis.call('LPOP', KEYS[3]) end
return 1`;
async function save(st, expectedRev, { push = '', pop = false } = {}) {
  st.rev = expectedRev + 1;
  const due = st.matches.filter((m) => m.status === 'called').reduce((a, m) => Math.min(a, m.callAt), Infinity);
  const ok = await redis(['EVAL', CAS, '4', K.rev, K.state, K.hist, K.due,
    String(expectedRev), String(st.rev), JSON.stringify(st), push, pop ? '1' : '0', Number.isFinite(due) ? String(due) : '']);
  return ok === 1;
}
// Login attempt limiter: 5 wrong passwords per address per 10 minutes.
async function failCount(ip, add) {
  const key = 'goat:fail:' + ip;
  if (!add) return Number(await redis(['GET', key])) || 0;
  const [n] = await pipe([['INCR', key], ['EXPIRE', key, 600]]);
  return n;
}
const clearFails = (ip) => redis(['DEL', 'goat:fail:' + ip]);

module.exports = { configured, head, load, lastSnapshot, save, failCount, clearFails };
