// /admin → Control Room (if logged in) or the login page. /admin/admin.js|admin.css → only when logged in.
// Files live in private/ so they are never served publicly.
const fs = require('fs');
const path = require('path');
const auth = require('../lib/auth');
const { SECRET } = require('../lib/http');

const PRIV = path.join(process.cwd(), 'private');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const ASSETS = new Set(['admin.js', 'admin.css']);

module.exports = (req, res) => {
  const admin = auth.isAdmin(req.headers.cookie, SECRET);
  const f = req.query && req.query.f;
  let file;
  if (!f) file = admin ? 'admin.html' : 'login.html';
  else if (ASSETS.has(f) && admin) file = f;
  else { res.statusCode = admin ? 404 : 401; return res.end(admin ? 'Not found' : 'Not logged in'); }
  res.setHeader('Content-Type', TYPES[path.extname(file)]);
  res.setHeader('Cache-Control', 'no-store');
  res.end(fs.readFileSync(path.join(PRIV, file)));
};
