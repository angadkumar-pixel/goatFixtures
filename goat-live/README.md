# THE GOAT — Live Fixtures

Match-day system for the tournament: a public home page, a live fixtures board (your intro animation, now driven by real data), an ads slideshow, and a password-protected admin control room. Every screen updates instantly when you change something in admin.

No install needed, just Node 18+:

```
node wifi-server.js
```

The console prints the addresses and the **admin password** (generated on first run and saved in `data/admin-password.txt`). To set your own: `ADMIN_PASSWORD=yourpass node wifi-server.js` (PowerShell: `$env:ADMIN_PASSWORD="yourpass"; node wifi-server.js`).

| Page | Who | What |
|---|---|---|
| `/` | Everyone | Home: Fixtures card (live preview) + Slideshow card |
| `/fixtures` | Everyone / venue TV | Live board. Press **F** for fullscreen |
| `/ads` | Everyone / venue TV | Loops everything in `public/ads/` (images and videos) |
| `/admin` | You only | Control room (login required) |

## On the Wi-Fi (phones, TVs, other laptops)

1. **One time only:** double-click `allow-wifi-phones.bat` and click **Yes**. It marks the Wi-Fi as Private and opens port 3000 to the local network only. Until this is done, Windows blocks phones.
2. Double-click `start-server.bat` (or run `node wifi-server.js`) and keep that window open.
3. Phones on the same Wi-Fi open the `http://192.168.x.x:3000` address shown in the window, or in **Control Room → Join on Wi-Fi** (with Copy buttons).

The board switches to a one-column layout on portrait phones automatically. Keep the laptop plugged in and stop it from sleeping during the event. The address can change if the router restarts, so check Join on Wi-Fi on the day.

## How the board behaves

- Shows the first **10** matches in the order list. Everything after that waits in **Up next**.
- **Click a match** in admin to set it **LIVE**: red LIVE chip, gold underline and sheen on the board, court auto-assigned (changeable). Live matches move to the top (can be turned off in Settings).
- **🔔 Finishing**: the match blinks FINISHING on the board.
- **End match**: it flips to FINISHED, bursts out, everyone shifts up one slot, and the next match from the queue enters. The camera zooms in on it with a spotlight.
- A match entering the top 10 gets **time = now + 15 min** (offset adjustable in Settings). Setting a time yourself locks it (● marker).
- Time changes flip like an airport split-flap board.
- The full intro replays every **10 min** (Settings; 0 = off), or on demand with **Replay intro**.
- **Undo** (Ctrl+Z) reverts any change, including an accidental End.

## Admin controls

- Reorder: drag (board ⇄ queue), the ↑ ↓ buttons, or focus a match and press **Shift+↑/↓**.
- Keys on a focused match: **Enter** live on/off · **F** finishing · **E** end · **Del** delete.
- Paste a list: one per line, `A | B`, `A vs B`, or `14:30 | A | B`.
- Completed matches can be restored.

## Files

- `wifi-server.js`: the whole backend (state, rules, auth, live push via Server-Sent Events). State is saved to `data/state.json` on every change, so a restart loses nothing.
- `public/js/board.js` + `public/css/board.css`: board renderer and animations (intro ported from `goat-fixtures-code/fixtures-scene.jsx`).
- `private/`: admin UI, served only after login.
- `public/ads/`: put your ad images/videos here (sorted by filename). Delete the two `sample-*.svg` files.

## Online: Vercel + Firebase Realtime Database

Same rules as the laptop version (`lib/core.js`). Vercel serves the pages and runs the admin actions (`api/`, region Singapore).
Firebase Realtime Database stores the fixtures and **pushes every change to all screens instantly**. Each change
sends only the matches that changed (usually under 1 KB). Phones work out the tentative times themselves.

Vercel → Settings → Environment Variables:
- `ADMIN_PASSWORD`: the Control Room password
- `FIREBASE_DB_URL`: e.g. `https://goat-fixtures-default-rtdb.asia-southeast1.firebasedatabase.app`
- `FIREBASE_SERVICE_ACCOUNT`: the whole service-account JSON file (Firebase → Project settings → Service accounts → Generate new private key)

Firebase Realtime Database → Rules:
```json
{ "rules": { ".read": false, ".write": false, "goat": { ".read": true } } }
```
Screens can read the fixtures; only the server (service account) can write, and undo history / login data stay private.

To change the slideshow, add or remove files in `public/ads`, commit and push; Vercel rebuilds by itself. On match day, play the venue TV slideshow from the laptop (`start-slideshow.bat`) so the big video files don't use Vercel bandwidth all day.
