// Vercel build step: list the slideshow files in public/ads → public/ads-list.json (served at /api/ads).
// To change the slideshow online: add/remove files in public/ads, commit, push — Vercel rebuilds automatically.
const fs = require('fs');
const path = require('path');

const ADS = path.join(__dirname, '..', 'public', 'ads');
const files = fs.existsSync(ADS) ? fs.readdirSync(ADS).filter((f) => /\.(png|jpe?g|webp|gif|avif|svg|mp4|webm|mov)$/i.test(f)) : [];
files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const list = files.map((f) => ({ src: '/ads/' + encodeURIComponent(f), video: /\.(mp4|webm|mov)$/i.test(f) }));
fs.writeFileSync(path.join(__dirname, '..', 'public', 'ads-list.json'), JSON.stringify(list));
console.log(`ads-list.json: ${list.length} slides`);
