// Vercel build step:
//  1. public/ads-list.json — the slideshow files in public/ads (served at /api/ads)
//  2. public/config.js     — tells the pages where the Firebase database is (from FIREBASE_DB_URL)
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public'), ADS = path.join(PUB, 'ads');
const files = fs.existsSync(ADS) ? fs.readdirSync(ADS).filter((f) => /\.(png|jpe?g|webp|gif|avif|svg|mp4|webm|mov)$/i.test(f)) : [];
files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const list = files.map((f) => ({ src: '/ads/' + encodeURIComponent(f), video: /\.(mp4|webm|mov)$/i.test(f) }));
fs.writeFileSync(path.join(PUB, 'ads-list.json'), JSON.stringify(list));

const dbUrl = (process.env.FIREBASE_DB_URL || '').trim().replace(/\/+$/, '');
fs.writeFileSync(path.join(PUB, 'config.js'), `window.GOAT_CONFIG = ${JSON.stringify({ dbUrl })};\n`);
console.log(`ads-list.json: ${list.length} slides · config.js: ${dbUrl ? 'Firebase ' + dbUrl : 'NO FIREBASE_DB_URL SET'}`);
if (!dbUrl && process.env.VERCEL) console.warn('WARNING: set FIREBASE_DB_URL in Vercel → Settings → Environment Variables, then redeploy.');
