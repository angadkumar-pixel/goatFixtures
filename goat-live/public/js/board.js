// THE GOAT — live fixtures board.
// Performance: every animation is a handful of key moments per element (transform/opacity only) handed to the GPU
// compositor, which fills in the motion. Nothing is pre-computed frame by frame, so the show starts instantly and
// stays smooth on phones and TVs even while the page is busy loading.
(() => {
  const SLOTS = 10, RW = 760, RH = 112;
  const fc = (v) => Math.max(0, Math.min(1, v));
  const fr = (t, s, e) => fc((t - s) / (e - s));
  const fl = (a, b, p) => a + (b - a) * p;
  const eIO = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (id) => document.getElementById(id);
  const PREVIEW = new URLSearchParams(location.search).has('preview');
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const skipMotion = () => document.hidden || REDUCED;
  // TV mode ("lite") for smart TVs and slow devices: no camera zoom at all (zooming the whole board is what TVs
  // can't do smoothly). Cards simply fade/slide in, changes swap in place. Phones and laptops keep the full show.
  // Force with ?lite=1, turn off with ?lite=0. Also switches on by itself if the screen cannot keep up.
  const QS = new URLSearchParams(location.search);
  const TV_UA = /SmartTV|SMART-TV|Tizen|Web0S|WebOS|NetCast|BRAVIA|HbbTV|AFT[A-Z]|CrKey|GoogleTV|Android ?TV|VIDAA|Hisense|PhilipsTV|Roku|\bTV\b/i.test(navigator.userAgent);
  let LITE = window.GOAT_LITE !== undefined ? !!window.GOAT_LITE : TV_UA; // decided by /js/lite.js (?lite=1 on a TV remembers it)
  document.documentElement.classList.toggle('lite', !!LITE);
  const setLite = (on) => { LITE = !!on; document.documentElement.classList.toggle('lite', LITE); if (L) { L.dive = LITE ? Math.min(L.dive, 1.6) : L.dive; L.focus = LITE ? Math.min(L.focus, 1.4) : L.focus; } };
  // wait for an animation to end (works on older browsers without Animation.finished)
  const RN = { R1: 'First Round', R64: 'Round of 64', R32: 'Round of 32', R16: 'Pre-Quarter', QF: 'Quarter Final', SF: 'Semi Final', F: 'FINAL' };
  // On the board: matches on court first, then the rest in the order they're expected to start.
  function boardOrder(s) {
    const on = s.matches.filter((m) => m.status === 'live' || m.status === 'called').concat(s.matches.filter((m) => m.status === 'bye')); // a bye being announced shows right after the courts
    const wait = s.matches.filter((m) => m.status !== 'live' && m.status !== 'called' && m.status !== 'bye' && !m.hold).map((m, i) => [m, i])
      .sort((x, y) => (x[0].time || Infinity) - (y[0].time || Infinity) || x[1] - y[1]).map((x) => x[0]);
    return on.concat(wait);
  }
  const fin = (a) => (a.finished ? a.finished.catch(() => {}) : new Promise((res) => { a.onfinish = res; a.oncancel = res; }));

  const vp = $('viewport'), stage = $('stage'), camEl = $('cam'), rowsEl = $('rows'), bgDark = $('bgDark'), beamsEl = $('beams'),
    panel = $('panel'), glow = $('panelGlow'), traceBox = $('traceBox'), traceRing = $('traceRing'), traceEdges = [...document.querySelectorAll('#traceBox .te')],
    heading = $('heading'), chrome = $('chrome'), sweepEl = $('sweep'), spot = $('spot'),
    statusEl = $('status'), clockEl = $('clock'), moreEl = $('more');

  // ── layout: the canvas takes the exact shape of the screen, so the board always fills it ──
  function makeLayout() {
    const w = innerWidth, h = innerHeight;
    if (w / h < 0.9) { // held upright: one column, rows enlarged; scaled to fit BOTH width and height, so it never scrolls
      const MIN = 1950, s = Math.min(w / 1080, h / MIN), W = Math.round(w / s), H = Math.round(h / s), ex = H - MIN, sc = 1.18;
      const ox = (W - 1080) / 2, top = 380 + ex * 0.3, gap = Math.min(146 + (ex * 0.7) / 9.5, 215);
      return { name: 'port', s, W, H, scale: sc, dive: 1.4, focus: 1.32,
        panel: { x: 24, y: 24, w: W - 48, h: H - 48 },
        heading: { left: 24, width: W - 48, top: 60 + ex * 0.12 }, status: { left: ox + 80, top: 300 + ex * 0.24 },
        clock: { right: ox + 80, top: 284 + ex * 0.24 }, more: { top: H - 64 },
        slot: (i) => ({ x: (W - RW * sc) / 2, y: top + i * gap }) };
    }
    const wide = w / h >= 16 / 9, s = wide ? h / 1080 : w / 1920, W = Math.round(w / s), H = Math.round(h / s);
    const ox = (W - 1920) / 2, oy = (H - 1080) / 2;
    return { name: 'land', s, W, H, scale: 1, dive: 2.15, focus: 1.75,
      panel: { x: 110, y: 40, w: W - 220, h: H - 80 },
      heading: { left: 110, width: W - 220, top: 92 + oy * 0.5 }, status: { left: ox + 168, top: 92 + oy * 0.5 },
      clock: { right: ox + 168, top: 80 + oy * 0.5 }, more: { top: H - 76 },
      slot: (i) => ({ x: ox + (i < 5 ? 170 : 990), y: oy + 372 + (i % 5) * 128 }) };
  }
  let L = null, FULL = { cx: 960, cy: 540, z: 1 };
  const px = (o) => Object.keys(o).reduce((r, k) => { r[k] = o[k] + 'px'; return r; }, {});
  function slotBox(i) {
    const { x, y } = L.slot(i);
    return { x, y, cx: x + (RW * L.scale) / 2, cy: y + (RH * L.scale) / 2 };
  }
  function applyLayout() {
    L = makeLayout();
    if (LITE) { L.dive = Math.min(L.dive, 1.6); L.focus = Math.min(L.focus, 1.4); } // lighter zoom on TVs
    stage.classList.toggle('portrait', L.name === 'port');
    for (const el of [stage, camEl]) { el.style.width = L.W + 'px'; el.style.height = L.H + 'px'; }
    stage.style.transform = `scale(${L.s})`;
    const tall = L.H * L.s > innerHeight + 1;
    document.documentElement.classList.toggle('scroll', tall);
    vp.style.height = tall ? L.H * L.s + 'px' : '';
    const p = L.panel;
    Object.assign(panel.style, px({ left: p.x, top: p.y, width: p.w, height: p.h }));
    Object.assign(glow.style, px({ left: p.x, top: p.y, width: p.w, height: p.h }));
    Object.assign(traceBox.style, px({ left: p.x, top: p.y, width: p.w, height: p.h }));
    Object.assign(heading.style, px(L.heading));
    Object.assign(statusEl.style, px(L.status));
    Object.assign(clockEl.style, px(L.clock));
    Object.assign(moreEl.style, px(L.more));
    FULL = { cx: L.W / 2, cy: L.H / 2, z: 1 };
    BEAMS.forEach((b) => { const x = (b.x * L.W) / 1920; b.d.style.left = x - 260 + 'px'; b.h.style.left = x - 26 + 'px'; });
    rows.forEach((r) => { if (r.slot >= 0) place(r, r.slot, false); });
    Object.assign(cam, FULL); applyCam();
  }
  let lastW = 0, lastH = 0, resizeT;
  function onResize() {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      // phones resize when the address bar slides; only re-layout for real changes (rotation, window resize)
      if (innerWidth === lastW && Math.abs(innerHeight - lastH) < 140) return;
      lastW = innerWidth; lastH = innerHeight;
      if (mode === 'intro') abortIntro();
      applyLayout();
    }, 120);
  }
  addEventListener('resize', onResize);

  // ── key moments → one compositor animation per element ──
  const EIO = 'cubic-bezier(.65,0,.35,1)', OUT = 'cubic-bezier(.22,1,.36,1)', OUT3 = 'cubic-bezier(.33,1,.68,1)', IN = 'cubic-bezier(.55,0,1,.45)', OUTQ = 'cubic-bezier(0,.55,.45,1)';
  // pts: [{ t: seconds, v: {css}, e: easing to the next point }]; the animation spans 0..total with fill both.
  function keys(A, el, pts, total) {
    pts = pts.filter((p, k) => k === 0 || p.t > pts[k - 1].t - 1e-9).sort((a, b) => a.t - b.t);
    const frames = [];
    pts.forEach((p) => {
      const off = Math.min(1, Math.max(0, p.t / total));
      if (frames.length && off <= frames[frames.length - 1].offset) frames.pop(); // same moment twice → keep the later
      frames.push(Object.assign({}, p.v, { offset: off, easing: p.e || 'linear' }));
    });
    if (frames[0].offset > 0) frames.unshift(Object.assign({}, pts[0].v, { offset: 0, easing: 'linear' }));
    if (frames[frames.length - 1].offset < 1) frames.push(Object.assign({}, pts[pts.length - 1].v, { offset: 1 }));
    const a = el.animate(frames, { duration: total * 1000, fill: 'both' });
    A.push(a);
    return a;
  }
  function startTogether(list) { const t = document.timeline.currentTime; list.forEach((a) => { a.startTime = t; }); }
  const endAll = (list) => list.forEach((a) => a.cancel());

  // ── light beams (intro) ──
  const BEAMS = [
    { x: 260, c: 'rgba(80,130,255,', a0: 35, a1: -25, ph: 0 },
    { x: 700, c: 'rgba(255,214,90,', a0: -30, a1: 20, ph: 1 },
    { x: 1220, c: 'rgba(255,214,90,', a0: 30, a1: -20, ph: 2 },
    { x: 1660, c: 'rgba(80,130,255,', a0: -35, a1: 25, ph: 3 },
  ].map((b) => {
    const d = document.createElement('div'); d.className = 'beam';
    d.style.background = `linear-gradient(180deg, ${b.c}0.75) 0%, ${b.c}0.22) 55%, ${b.c}0) 100%)`;
    const h = document.createElement('div'); h.className = 'beam-head';
    h.style.boxShadow = `0 0 40px 14px ${b.c}0.8)`;
    beamsEl.append(d, h);
    return { ...b, d, h };
  });

  // ── camera ──
  const cam = { ...FULL };
  const camTransform = (c, sx = 0, sy = 0) => `translate(${L.W / 2 - c.cx * c.z + sx}px, ${L.H / 2 - c.cy * c.z + sy}px) scale(${c.z})`;
  function applyCam() { camEl.style.transform = camTransform(cam); }
  async function camTo(t, ms) {
    if (skipMotion()) { Object.assign(cam, t); return applyCam(); }
    const a = camEl.animate([{ transform: camTransform(cam) }, { transform: camTransform(t) }], { duration: ms, easing: EIO, fill: 'forwards' });
    await fin(a);
    Object.assign(cam, t); applyCam(); a.cancel();
  }

  // ── rows ──
  const rows = new Map(); // id -> row
  function buildRow(m) {
    const el = document.createElement('div');
    el.className = 'row';
    el.innerHTML = '<div class="card"><div class="blink"></div><div class="plate a"><i class="tint"></i><span class="name"></span></div>' +
      '<div class="plate b"><i class="tint"></i><span class="name"></span></div><div class="vs">V</div><div class="chip"></div>' +
      '<div class="tag"></div><div class="note">Your match is about to start</div><div class="cdbar"><i></i></div><div class="flash"></div><div class="ring"></div></div>';
    const q = (s) => el.querySelector(s);
    const r = { el, m: null, slot: -1, chipKey: '', seenReady: 0, card: q('.card'), pa: q('.plate.a'), pb: q('.plate.b'), na: q('.a .name'), nb: q('.b .name'),
      vs: q('.vs'), tag: q('.tag'), chip: q('.chip'), bar: q('.cdbar i'), flash: q('.flash'), ring: q('.ring') };
    rowsEl.append(el);
    rows.set(m.id, r);
    paintRow(r, m, false);
    r.seenReady = m.readyAt || 0; // a row that is already "ready" when first drawn doesn't trigger the zoom
    return r;
  }
  // Shrink long names to fit: one measurement each (reads batched, then writes), never a measure-resize loop.
  function fitAll(list) {
    const els = []; list.forEach((r) => els.push(r.na, r.nb));
    els.forEach((el) => { el.style.fontSize = '38px'; });
    const widths = els.map((el) => el.offsetWidth);
    els.forEach((el, k) => { if (widths[k] > 292) el.style.fontSize = Math.max(20, Math.floor((38 * 292) / widths[k])) + 'px'; });
  }
  let toFit = [];
  const fitName = (el) => { // batched: all names changed in this pass are measured together
    if (!toFit.length) Promise.resolve().then(() => { const l = toFit; toFit = []; fitAll(l.map((e) => ({ na: e, nb: e }))); });
    toFit.push(el);
  };
  function fmtLeft(at) {
    const s = Math.max(0, Math.ceil((at - GoatLive.now()) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function chipHTML(m) {
    const ct = m.court ? ` · COURT ${esc(m.court)}` : '';
    if (m.status === 'live') return m.ending ? `FINISHING${ct}` : `<span class="dot"></span>LIVE${ct}`;
    if (m.status === 'called') return `COURT ${esc(m.court)} · <span class="cd-label">STARTS IN</span> <span class="cd">${fmtLeft(m.callAt)}</span>`;
    if (m.status === 'bye') return 'BYE' + (m.byeTo ? ' · THROUGH TO ' + esc((RN[m.byeTo] || m.byeTo).toUpperCase()) : ' · THROUGH');
    if (m.ready) return `BE READY${m.readyCourt ? ' · COURT ' + esc(m.readyCourt) : ''}`;
    if (!m.time) return 'TO BE DECIDED';
    return `<span class="est">EST</span>${esc(GoatLive.fmtTime(m.time))}`; // tentative time
  }
  const chipSig = (m) => chipHTML(m).replace(/<span class="cd">[^<]*/, '') + '|' + (m.callAt || '');
  function tickCountdowns() {
    rows.forEach((r) => {
      const m = r.m;
      if (!m || m.status !== 'called') return;
      const cd = r.chip.querySelector('.cd');
      if (cd) cd.textContent = fmtLeft(m.callAt);
      const left = m.callAt - GoatLive.now(), span = Math.max(1, m.callAt - (m.calledAt || m.callAt));
      r.bar.style.transform = `scaleX(${fc(left / span)})`;
      r.el.classList.toggle('soon', left <= 60000);
      r.el.classList.toggle('due', left <= 0);
    });
  }
  setInterval(tickCountdowns, 250);

  function flipChip(r) { // split-flap style flip; always lands on the latest text
    if (skipMotion() || LITE) { r.chip.innerHTML = r.chipHTML; return; }
    const P = 'perspective(400px) ';
    const a = r.chip.animate([{ transform: P + 'rotateX(0deg)' }, { transform: P + 'rotateX(-90deg)' }], { duration: 160, easing: 'ease-in', fill: 'forwards' });
    a.onfinish = () => {
      r.chip.innerHTML = r.chipHTML;
      a.cancel();
      r.chip.animate([{ transform: P + 'rotateX(90deg)' }, { transform: P + 'rotateX(0deg)' }], { duration: 280, easing: 'cubic-bezier(.2,1.5,.4,1)' });
    };
  }
  function burst(r) {
    if (skipMotion()) return;
    if (LITE) { r.flash.animate([{ opacity: 0 }, { opacity: 0.7 }, { opacity: 0 }], { duration: 700 }); return; }
    r.flash.animate([{ opacity: 0 }, { opacity: 0.85 }, { opacity: 0 }], { duration: 600 });
    r.ring.animate([{ opacity: 1, transform: 'scale(.3)' }, { opacity: 0, transform: 'scale(3.2)' }], { duration: 800, easing: 'cubic-bezier(.22,1,.36,1)' });
    r.card.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 500, easing: 'cubic-bezier(.2,1.4,.4,1)' });
  }
  function paintRow(r, m, animate = true) {
    if (animate && r.m && r.m.status !== 'live' && m.status === 'live') burst(r);
    if (!r.m || r.m.a !== m.a || r.m.pa !== m.pa) { r.na.textContent = m.a || m.pa || 'TBA'; r.na.classList.toggle('tbd', !m.a); fitName(r.na); }
    if (!r.m || r.m.b !== m.b || r.m.pb !== m.pb) { r.nb.textContent = m.b || m.pb || 'TBA'; r.nb.classList.toggle('tbd', !m.b); fitName(r.nb); }
    const tg = m.cat ? `${m.cat} · ${RN[m.rd] || m.rd} · #${m.no}` : '';
    if (r.tag.textContent !== tg) { r.tag.textContent = tg; r.tag.style.display = tg ? '' : 'none'; }
    r.el.classList.toggle('live', m.status === 'live');
    r.el.classList.toggle('ending', m.status === 'live' && !!m.ending);
    r.el.classList.toggle('called', m.status === 'called');
    r.el.classList.toggle('ready', m.status === 'queued' && !!m.ready);
    if (m.status !== 'called') r.el.classList.remove('soon', 'due');
    const sig = chipSig(m);
    if (sig !== r.chipKey) {
      const had = r.chipKey;
      r.chipKey = sig; r.chipHTML = chipHTML(m);
      animate && had ? flipChip(r) : (r.chip.innerHTML = r.chipHTML);
    }
    r.m = m;
    tickCountdowns();
  }
  function place(r, slot, animate = true, delay = 0) {
    const b = slotBox(slot);
    if (!animate) r.el.style.transition = 'none';
    r.el.style.transitionDelay = animate ? delay + 'ms' : '0ms';
    r.el.style.transform = `translate(${b.x}px, ${b.y}px) scale(${L.scale})`;
    if (!animate) { void r.el.offsetWidth; r.el.style.transition = ''; }
    r.slot = slot;
  }

  // The "slam" arrival (big → overshoot → settle, plates slide in, V punches, flash + ring) as key moments from time te.
  function slamKeys(A, r, te, total) {
    const S = (s) => `scale(${s})`;
    keys(A, r.card, [{ t: 0, v: { opacity: 0, transform: S(1.6) } }, { t: te, v: { opacity: 0, transform: S(1.6) }, e: OUT3 },
      { t: te + 0.07, v: { opacity: 0.6, transform: S(1.3) }, e: OUT3 }, { t: te + 0.3, v: { opacity: 1, transform: S(0.96) }, e: OUT3 },
      { t: te + 0.45, v: { opacity: 1, transform: S(1.08) }, e: OUT3 }, { t: te + 0.6, v: { opacity: 1, transform: S(1) } }], total);
    if (LITE) return; // TV: the card itself slams in; skip the extra plate/ring/flash layers
    const X = (x) => ({ transform: `translateX(${x}px)` });
    keys(A, r.pa, [{ t: 0, v: X(-160) }, { t: te, v: X(-160), e: OUT3 }, { t: te + 0.35, v: X(0) }], total);
    keys(A, r.pb, [{ t: 0, v: X(160) }, { t: te, v: X(160), e: OUT3 }, { t: te + 0.35, v: X(0) }], total);
    keys(A, r.vs, [{ t: 0, v: { opacity: 0, transform: S(3) } }, { t: te + 0.12, v: { opacity: 0, transform: S(3) }, e: OUT3 },
      { t: te + 0.22, v: { opacity: 1, transform: S(1.6) }, e: OUT3 }, { t: te + 0.42, v: { opacity: 1, transform: S(1) } }], total);
    keys(A, r.chip, [{ t: 0, v: { transform: 'translateY(-30px)' } }, { t: te, v: { transform: 'translateY(-30px)' }, e: OUT3 }, { t: te + 0.35, v: { transform: 'translateY(0)' } }], total);
    keys(A, r.flash, [{ t: 0, v: { opacity: 0 } }, { t: te, v: { opacity: 0 } }, { t: te + 0.15, v: { opacity: 0.85 } }, { t: te + 0.3, v: { opacity: 0.85 } }, { t: te + 0.75, v: { opacity: 0 } }], total);
    keys(A, r.ring, [{ t: 0, v: { opacity: 0, transform: S(0.3) } }, { t: te + 0.3, v: { opacity: 0, transform: S(0.3) } }, { t: te + 0.31, v: { opacity: 1, transform: S(0.3) }, e: OUT3 },
      { t: te + 0.9, v: { opacity: 0, transform: S(3.2) } }], total);
  }
  async function slam(r) {
    r.card.style.opacity = '';
    if (skipMotion()) return;
    if (LITE) { await fin(r.card.animate([{ opacity: 0, transform: 'translateY(24px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 450, easing: OUT })); return; }
    const A = [];
    slamKeys(A, r, 0, 0.95);
    startTogether(A);
    await fin(A[0]);
    endAll(A);
  }

  async function exitRow(r, ended) {
    rows.delete(r.m.id);
    if (skipMotion()) return r.el.remove();
    if (ended) {
      r.el.classList.remove('ending');
      r.el.classList.add('finished');
      const w = ended.winner === 'a' ? ended.a : ended.winner === 'b' ? ended.b : '';
      if (w) r.el.classList.add('won-' + ended.winner);
      r.chipHTML = w ? '🏆 ' + esc(w) + ' WINS' : 'FINISHED'; r.chipKey = r.chipHTML;
      flipChip(r);
      await sleep(w ? 2200 : 650); // let everyone read the winner
      if (LITE) { await fin(r.card.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 450, fill: 'forwards' })); r.el.remove(); return; }
      r.flash.animate([{ opacity: 0 }, { opacity: 0.9 }, { opacity: 0 }], { duration: 520 });
      r.ring.animate([{ opacity: 1, transform: 'scale(.3)' }, { opacity: 0, transform: 'scale(3.2)' }], { duration: 700, easing: 'cubic-bezier(.22,1,.36,1)' });
      await fin(r.card.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(1.05)', opacity: 1, offset: 0.3 }, { transform: 'scale(0.6)', opacity: 0 }],
        { duration: 800, delay: 120, easing: 'cubic-bezier(.55,0,.75,.2)', fill: 'forwards' }));
    } else {
      await fin(r.card.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(30px)' }],
        { duration: 420, easing: 'ease-in', fill: 'forwards' }));
    }
    r.el.remove();
  }

  function spotlight(b) {
    if (skipMotion()) return;
    spot.style.left = b.cx + 'px'; spot.style.top = b.cy + 'px';
    spot.animate([{ opacity: 0, transform: 'scale(.5)' }, { opacity: 1, transform: 'scale(1)', offset: 0.35 }, { opacity: 0, transform: 'scale(1.3)' }],
      { duration: 1700, easing: 'ease-out' });
    sweepEl.animate([{ transform: 'translateX(0) rotate(18deg)' }, { transform: `translateX(${L.panel.w + 700}px) rotate(18deg)` }], { duration: 1100, easing: 'cubic-bezier(.4,0,.2,1)' });
  }
  async function focusOn(r, hold, fn) { // zoom the camera onto one row, light it, then return
    const b = slotBox(r.slot);
    await camTo({ cx: b.cx, cy: b.cy, z: L.focus }, 750);
    spotlight(b);
    if (fn) await fn();
    await sleep(hold);
  }

  // Diff the board against the new state: finished matches leave, the rest glide up, newcomers zoom in.
  async function reconcile(s) {
    const vis = boardOrder(s).slice(0, SLOTS);
    const ids = new Set(vis.map((m) => m.id));
    const doneById = new Map((s.done || []).map((d) => [d.id, d]));
    vis.forEach((m) => { const r = rows.get(m.id); if (r) paintRow(r, m); });

    const exits = [...rows.values()].filter((r) => !ids.has(r.m.id));
    if (exits.length) await Promise.all(exits.map((r) => exitRow(r, doneById.get(r.m.id))));

    let k = 0;
    vis.forEach((m, i) => { const r = rows.get(m.id); if (r && r.slot !== i) place(r, i, true, k++ * 55); });
    if (k && !skipMotion()) await sleep(900 + (k - 1) * 55);

    const rs = vis.map((m, i) => [m, i]).filter(([m]) => !rows.has(m.id))
      .map(([m, i]) => { const r = buildRow(m); place(r, i, false); r.card.style.opacity = 0; return r; });
    const camOk = !PREVIEW && !skipMotion() && !LITE; // TV mode: never zoom
    let zoomed = false;
    if (rs.length && rs.length <= 3 && camOk) {
      for (const r of rs) await focusOn(r, 1100, () => slam(r));
      zoomed = true;
    } else if (rs.length) {
      await Promise.all(rs.map((r, i) => sleep(i * 140).then(() => slam(r))));
    }
    // "Be ready": the first time a match is flagged, zoom onto it so the players notice.
    const fresh = [...rows.values()].filter((r) => r.m.ready && r.m.readyAt && r.m.readyAt !== r.seenReady);
    for (const r of fresh) {
      r.seenReady = r.m.readyAt;
      if (camOk) { await focusOn(r, 2200, async () => burst(r)); zoomed = true; } else burst(r);
    }
    if (zoomed) await camTo(FULL, 900);
  }

  // ── intro: lights, panel trace, heading slam, camera diving onto every match, reveal ──
  // Described as key moments per element; the graphics chip fills in the motion, so it starts instantly and can't fall behind.
  let introAnims = [], introDone = null;
  function setFinal() {
    bgDark.style.opacity = 0; beamsEl.style.opacity = 0; panel.style.opacity = 1; glow.style.opacity = 0; traceBox.style.opacity = 1;
    heading.style.opacity = 1; heading.style.transform = ''; chrome.style.opacity = 1;
    rows.forEach((r) => { r.card.style.opacity = ''; });
    Object.assign(cam, FULL); applyCam();
  }
  function abortIntro() { if (introDone) introDone(); }
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  async function playIntro() {
    mode = 'intro';
    lastIntroAt = Date.now();
    rows.forEach((r) => r.el.remove()); rows.clear();
    const rs = boardOrder(latest).slice(0, SLOTS).map((m, i) => { const r = buildRow(m); place(r, i, false); r.card.style.opacity = 0; return r; });
    fitAll(rs);
    if (skipMotion()) { setFinal(); return; }
    if (LITE) return playIntroTV(rs);
    // let the browser lay out and paint the new rows (screen is still dark) before the clock starts
    await frame(); await frame();
    const slot = 1.1, C = { Lights: 1, Matches: 3.6 };
    C.Reveal = C.Matches + Math.max(1, rs.length) * slot;
    const total = C.Reveal + 2.6, A = (introAnims = []);
    const K = (el, pts) => keys(A, el, pts, total);

    // camera: hold, dive onto each match as it slams in (with a little dip between rows and a shake on impact), pull back
    const camV = (c, sx = 0, sy = 0) => ({ transform: camTransform(c, sx, sy) });
    const camPts = [{ t: 0, v: camV(FULL) }];
    rs.forEach((r, i) => {
      const s0 = C.Matches + i * slot, d = i === 0 ? 0.6 : 0.38;
      const prev = i === 0 ? FULL : Object.assign({}, slotBox(i - 1), { z: L.dive }), cur = Object.assign({}, slotBox(i), { z: L.dive });
      if (i === 0) camPts.push({ t: s0, v: camV(prev), e: EIO }, { t: s0 + d, v: camV(cur) });
      else {
        const dip = (0.18 * (L.dive - 1)) / 0.85, mid = { cx: (prev.cx + cur.cx) / 2, cy: (prev.cy + cur.cy) / 2, z: L.dive - dip };
        camPts.push({ t: s0, v: camV(prev), e: IN }, { t: s0 + d / 2, v: camV(mid), e: OUTQ }, { t: s0 + d, v: camV(cur) });
      }
      if (!LITE) { // impact shake as the card lands
        const hit = s0 + Math.max(0.55, d + 0.02);
        [[0, 0], [0.03, 8, -5], [0.07, -6, 4], [0.12, 4, -3], [0.18, -2, 1], [0.26, 0, 0]].forEach(([dt, sx = 0, sy = 0]) => camPts.push({ t: hit + dt, v: camV(cur, sx, sy) }));
      }
    });
    if (rs.length) {
      camPts.push({ t: C.Reveal, v: camV(Object.assign({}, slotBox(rs.length - 1), { z: L.dive })), e: EIO });
      camPts.push({ t: C.Reveal + 1.5, v: camV(FULL) });
    }
    K(camEl, camPts);

    // darkness and light beams
    const darkPts = [{ t: 0, v: { opacity: 1 } }, { t: C.Reveal + 0.2, v: { opacity: 1 }, e: EIO }, { t: C.Reveal + 1.6, v: { opacity: 0 } }];
    K(bgDark, darkPts); K(beamsEl, darkPts);
    BEAMS.forEach((b, i) => {
      const on = C.Lights + i * 0.18;
      const rot = (t) => `rotate(${fl(b.a0, b.a1, eIO(fr(t, C.Lights, C.Matches))) + (LITE ? 0 : Math.sin(t * 1.6 + b.ph) * 6)}deg)`;
      const times = [0, on, on + 0.12];
      for (let t = on + 0.5; t < C.Reveal + 1.6; t += LITE ? 1 : 0.5) times.push(t); // gentle sway, a point every half second
      K(b.d, times.map((t) => ({ t, v: { opacity: t < on + 0.12 ? 0 : 0.9, transform: rot(t) }, e: 'ease-in-out' })));
      K(b.h, [{ t: 0, v: { opacity: 0 } }, { t: on, v: { opacity: 0 } }, { t: on + 0.12, v: { opacity: 1 } }]);
    });
    K(panel, [{ t: 0, v: { opacity: 0 } }, { t: C.Lights + 0.9, v: { opacity: 0 }, e: OUT3 }, { t: C.Lights + 1.6, v: { opacity: 1 } }]);
    if (!LITE) K(glow, [{ t: 0, v: { opacity: 0 } }, { t: C.Lights + 0.9, v: { opacity: 0 }, e: OUT3 }, { t: C.Lights + 1.6, v: { opacity: 1 } },
      { t: C.Reveal + 0.2, v: { opacity: 1 }, e: EIO }, { t: C.Reveal + 1.6, v: { opacity: 0 } }]);
    { // gold outline runs around the panel (top → right → bottom → left), then the rounded frame settles in
      const t0 = C.Lights + 0.5, w = L.panel.w, h = L.panel.h, per = 2 * (w + h);
      let at = t0;
      K(traceBox, [{ t: 0, v: { opacity: 0 } }, { t: t0, v: { opacity: 0 } }, { t: t0 + 0.01, v: { opacity: 1 } }]);
      traceEdges.forEach((el, k) => {
        const len = k % 2 ? h : w, d = len / per, ax = k % 2 ? 'scaleY' : 'scaleX';
        K(el, [{ t: 0, v: { transform: ax + '(0)' } }, { t: at, v: { transform: ax + '(0)' } }, { t: at + d, v: { transform: ax + '(1)' } }]);
        at += d;
      });
      K(traceRing, [{ t: 0, v: { opacity: 0 } }, { t: at - 0.1, v: { opacity: 0 } }, { t: at + 0.25, v: { opacity: 1 } }]);
    }
    const h0 = C.Lights + 1.3;
    K(heading, [{ t: 0, v: { opacity: 0, transform: 'scale(1.5)' } }, { t: h0, v: { opacity: 0, transform: 'scale(1.5)' }, e: OUT },
      { t: h0 + 0.2, v: { opacity: 1, transform: 'scale(1.15)' }, e: OUT }, { t: h0 + 0.36, v: { opacity: 1, transform: 'scale(0.97)' }, e: OUT }, { t: h0 + 0.6, v: { opacity: 1, transform: 'scale(1)' } }]);
    K(chrome, [{ t: 0, v: { opacity: 0 } }, { t: C.Reveal + 0.8, v: { opacity: 0 } }, { t: C.Reveal + 1.8, v: { opacity: 1 } }]);
    K(sweepEl, [{ t: 0, v: { transform: 'translateX(0) rotate(18deg)' } }, { t: C.Reveal + 1.4, v: { transform: 'translateX(0) rotate(18deg)' }, e: 'cubic-bezier(.4,0,.2,1)' },
      { t: C.Reveal + 2.4, v: { transform: `translateX(${L.panel.w + 700}px) rotate(18deg)` } }]);
    rs.forEach((r, i) => slamKeys(A, r, C.Matches + i * slot + 0.25, total));
    startTogether(A);
    // The first second is pure darkness. The browser prepares all the graphics now (that can take a moment on a
    // slow phone), then the clock restarts from zero so nothing visible ever waits on that work.
    await frame(); await frame(); await frame();
    if (introAnims !== A) return; // replaced meanwhile
    startTogether(A);
    try { performance.mark('goat-intro'); } catch (e) {}
    return new Promise((res) => {
      let t;
      introDone = () => { clearTimeout(t); introDone = null; setFinal(); endAll(A); introAnims = []; res(); };
      t = setTimeout(() => introDone && introDone(), total * 1000 + 50);
    });
  }

  // TV intro: no camera, no beams, no outline trace — the board fades up, the heading drops in, the matches slide in
  // one after another. Only opacity + small moves of single cards, so even a weak TV stays smooth from the first frame.
  async function playIntroTV(rs) {
    Object.assign(cam, FULL); applyCam();
    beamsEl.style.opacity = 0; glow.style.opacity = 0; traceBox.style.opacity = 1;
    // Draw everything once, almost invisible, while the screen is still dark — a TV's first paint of the board is the
    // slow part, so it happens here instead of in the middle of the fade.
    const warm = [panel, heading, chrome, traceBox].concat(rs.map((r) => r.card));
    warm.forEach((el) => { el.style.opacity = 0.01; });
    bgDark.style.opacity = 1;
    await frame(); await frame(); await frame();
    const A = (introAnims = []), total = 1.6 + rs.length * 0.14 + 0.6;
    const K = (el, pts) => keys(A, el, pts, total);
    K(bgDark, [{ t: 0, v: { opacity: 1 } }, { t: 0.2, v: { opacity: 1 }, e: EIO }, { t: 1.0, v: { opacity: 0 } }]);
    K(panel, [{ t: 0, v: { opacity: 0 } }, { t: 0.2, v: { opacity: 0 }, e: OUT3 }, { t: 0.9, v: { opacity: 1 } }]);
    K(traceBox, [{ t: 0, v: { opacity: 0 } }, { t: 0.4, v: { opacity: 0 } }, { t: 1.0, v: { opacity: 1 } }]);
    K(heading, [{ t: 0, v: { opacity: 0, transform: 'translateY(-30px)' } }, { t: 0.5, v: { opacity: 0, transform: 'translateY(-30px)' }, e: OUT }, { t: 1.1, v: { opacity: 1, transform: 'translateY(0)' } }]);
    K(chrome, [{ t: 0, v: { opacity: 0 } }, { t: 0.8, v: { opacity: 0 } }, { t: 1.4, v: { opacity: 1 } }]);
    rs.forEach((r, i) => { const t0 = 1.0 + i * 0.14; K(r.card, [{ t: 0, v: { opacity: 0, transform: 'translateY(26px)' } }, { t: t0, v: { opacity: 0, transform: 'translateY(26px)' }, e: OUT }, { t: t0 + 0.5, v: { opacity: 1, transform: 'translateY(0)' } }]); });
    startTogether(A);
    return new Promise((res) => {
      let t;
      introDone = () => { clearTimeout(t); introDone = null; setFinal(); endAll(A); introAnims = []; res(); };
      t = setTimeout(() => introDone && introDone(), total * 1000 + 50);
    });
  }

  // ── controller: serialises animations, coalesces bursts of admin changes ──
  let mode = 'boot', latest = null, lastNonce = null, lastIntroAt = 0, busy = false, pending = false, replayWanted = false;
  async function pump() {
    if (busy || mode !== 'live') return;
    busy = true;
    while (pending) { pending = false; try { await reconcile(latest); } catch (e) { console.error(e); } }
    busy = false;
    maybeReplay();
  }
  async function intro() {
    replayWanted = false;
    await playIntro();
    mode = 'live'; pending = true; pump();
  }
  function maybeReplay() {
    if (PREVIEW || mode !== 'live' || busy || !latest) return;
    const every = (latest.settings.replayMinutes || 0) * 60000;
    if (replayWanted || (every > 0 && Date.now() - lastIntroAt > every && !document.hidden)) intro();
  }
  setInterval(maybeReplay, 3000);

  function updateChrome(s) {
    $('title').textContent = s.title || '';
    $('subtitle').textContent = s.subtitle || '';
    $('liveCount').textContent = s.matches.filter((m) => m.status === 'live').length;
    const deck = s.matches.filter((m) => m.status === 'called').length;
    $('deck').textContent = deck ? `${deck} ON DECK` : '';
    const shown = boardOrder(s).length, extra = shown - SLOTS; // only the order of play (not matches still in their category list)
    moreEl.textContent = extra > 0 ? `+${extra} more match${extra > 1 ? 'es' : ''} in queue` : shown ? '' : 'Fixtures coming up shortly';
  }

  // ── boot ──
  lastW = innerWidth; lastH = innerHeight;
  applyLayout();
  bgDark.style.opacity = 1;
  const fontsOrTimeout = Promise.race([document.fonts && document.fonts.load ? Promise.all(['400 40px Anton', '700 40px "Barlow Condensed"', '600 40px "Barlow Condensed"'].map((f) => document.fonts.load(f))).catch(() => {}) : sleep(0), sleep(3000)]);
  window.onGoatLite = () => setLite(true);
  if (!window.GOAT_LITE_LOCKED && !LITE) { // auto-detect a struggling screen (e.g. a smart TV that does not say so)
    const gaps = []; let last = 0;
    const probe = (t) => { if (last) gaps.push(t - last); last = t; if (gaps.length < 40) requestAnimationFrame(probe); else { gaps.sort((a, b) => a - b); if (gaps[20] > 34) setLite(true); } };
    requestAnimationFrame(probe);
  } // never let slow font downloads delay the show

  GoatLive.connect((s) => {
    latest = s;
    updateChrome(s);
    if (mode === 'boot') {
      mode = 'starting';
      lastNonce = s.replayNonce;
      if (PREVIEW) { setFinal(); mode = 'live'; pending = true; pump(); }
      else fontsOrTimeout.then(intro);
      return;
    }
    if (s.replayNonce !== lastNonce) { lastNonce = s.replayNonce; if (!PREVIEW) replayWanted = true; }
    pending = true;
    pump();
    maybeReplay();
  }, (ok) => $('conn').classList.toggle('show', !ok));

  if (document.fonts) document.fonts.ready.then(() => fitAll([...rows.values()]));

  // ── clock ──
  let lastClock = '';
  setInterval(() => {
    const d = new Date(GoatLive.now()), p2 = (n) => String(n).padStart(2, '0');
    const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`, sec = `:${p2(d.getSeconds())}`;
    if (hm + sec === lastClock) return;
    lastClock = hm + sec;
    $('clockHM').textContent = hm; $('clockS').textContent = sec;
  }, 250);

  // ── HUD + fullscreen ──
  const hud = $('hud');
  let idleT;
  const fs = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
  if (PREVIEW) hud.remove();
  else {
    const wake = () => {
      hud.classList.add('show'); document.body.classList.remove('idle');
      clearTimeout(idleT);
      idleT = setTimeout(() => { hud.classList.remove('show'); document.body.classList.add('idle'); }, 2500);
    };
    addEventListener('mousemove', wake);
    addEventListener('touchstart', wake, { passive: true });
    $('fsBtn').onclick = fs;
    addEventListener('keydown', (e) => { if (e.key === 'f' || e.key === 'F') fs(); });
    // Phones: the first tap anywhere goes true fullscreen (Android; iPhone uses "Add to Home Screen").
    if (matchMedia('(pointer: coarse)').matches && document.documentElement.requestFullscreen) {
      addEventListener('pointerup', (e) => { if (!document.fullscreenElement && !e.target.closest('.hud')) fs(); }, { once: true });
    }
  }
})();
