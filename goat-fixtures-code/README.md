# THE GOAT — Fixtures intro (source code)

Open `GOAT Fixtures.dc.html` in a browser served from this folder (e.g. `npx serve .` or VS Code Live Server). Opening it as a plain file may block script loading in some browsers.

## Files
- `GOAT Fixtures.dc.html` — entry page. Holds the scene timings (`OM_SCENES`), play-once setting, and the fixture data (`TWEAK_DEFAULTS`: title, subtitle, m1–m10 as `time | player A | player B`).
- `fixtures-scene.jsx` — the whole design + animation. Edit this for layout, colours, fonts, motion.
  - `PANEL`, `ROW` — panel and match-row positions/sizes (1920×1080 canvas).
  - `camera()` — zoom/pan to each match, zoom level 1.85.
  - `Beams` — opening light show.
  - `Match` — one fixture row and its slam-in animation.
  - `FixturesPiece` — background, panel, heading, timing of each part.
  - `decideReplay()` — plays the intro on first open or when fixtures change; otherwise opens on the final page. `?replay` forces it; `?obs=1` hides the player bar.
- `animations-v3.jsx` — timeline engine (playback bar, scrubbing, video export). No need to edit.
- `tweaks-panel.jsx` — Tweaks side panel. No need to edit.
- `support.js` — runtime that loads the page. No need to edit.

## Timings
Change `dur` (seconds) per scene in `OM_SCENES` in the HTML: Black, Lights, Matches (split evenly across 10 matches), Reveal, Hold.
