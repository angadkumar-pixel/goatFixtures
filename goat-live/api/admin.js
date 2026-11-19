// /admin → Control Room (if logged in) or the login page. /admin/admin.js|admin.css → only when logged in.
// Files live in private/ so they are never served publicly. Each path is written out in full so Vercel's
// bundler sees them and ships them with this function.
const fs = require('fs');
const path = require('path');
const auth = require('../lib/auth');
const { SECRET } = require('../lib/http');

const FILES = {
  'admin.html': { file: () => path.join(__dirname, '..', 'private', 'admin.html'), type: 'text/html; charset=utf-8' },
  'login.html': { file: () => path.join(__dirname, '..', 'private', 'login.html'), type: 'text/html; charset=utf-8' },
  'admin.js': { file: () => path.join(__dirname, '..', 'private', 'admin.js'), type: 'text/javascript; charset=utf-8' },
  'admin.css': { file: () => path.join(__dirname, '..', 'private', 'admin.css'), type: 'text/css; charset=utf-8' },
};
// read once per cold start; also try the project root in case the runtime lays files out differently
function read(name) {
  const tries = [FILES[name].file(), path.join(process.cwd(), 'private', name), path.join(process.cwd(), 'goat-live', 'private', name)];
  for (const p of tries) { try { return fs.readFileSync(p); } catch {} }
  throw new Error(`private/${name} was not included in the deployment (looked in: ${tries.join(' | ')})`);
}

module.exports = (req, res) => {
  try {
    const admin = auth.isAdmin(req.headers.cookie, SECRET);
    const f = req.query && req.query.f;
    let name;
    if (!f) name = admin ? 'admin.html' : 'login.html';
    else if ((f === 'admin.js' || f === 'admin.css') && admin) name = f;
    else { res.statusCode = admin ? 404 : 401; return res.end(admin ? 'Not found' : 'Not logged in'); }
    res.setHeader('Content-Type', FILES[name].type);
    res.setHeader('Cache-Control', 'no-store');
    res.end(read(name));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Control Room error: ' + e.message);
  }
};
