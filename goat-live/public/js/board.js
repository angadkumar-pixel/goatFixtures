// THE GOAT — live fixtures board.
// Performance: every animation is pre-computed ("baked") into Web Animations keyframes on transform/opacity only,
// so the GPU compositor plays them and phones stay smooth even when the page's main thread is busy.
(() => {
  const SLOTS = 10, RW = 760, RH = 112;
  const fc = (v) => Math.max(0, Math.min(1, v));
  const fr = (t, s, e) => fc((t - s) / (e - s));
  const fl = (a, b, p) => a + (b - a) * p;
  const eOut = (p) => 1 - Math.pow(1 - p, 3);
  const eIO = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (id) => document.getElementById(id);
  const PREVIEW = new URLSearchParams(location.search).has('preview');
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const skipMotion = () => document.hidden || REDUCED;

  const vp = $('viewport'), stage = $('stage'), camEl = $('cam'), rowsEl = $('rows'), bgDark = $('bgDark'), beamsEl = $('beams'),
    panel = $('panel'), glow = $('panelGlow'), traceSvg = $('traceSvg'), trace = $('trace'), traceGlow = $('traceGlow'),
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
  let L = null, PERIM = 0, FULL = { cx: 960, cy: 540, z: 1 };
  const px = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v + 'px']));
  function slotBox(i) {
    const { x, y } = L.slot(i);
    return { x, y, cx: x + (RW * L.scale) / 2, cy: y + (RH * L.scale) / 2 };
  }
  function applyLayout() {
    L = makeLayout();
    stage.classList.toggle('portrait', L.name === 'port');
    for (const el of [stage, camEl]) { el.style.width = L.W + 'px'; el.style.height = L.H + 'px'; }
    stage.style.transform = `scale(${L.s})`;
    const tall = L.H * L.s > innerHeight + 1;
    document.documentElement.classList.toggle('scroll', tall);
    vp.style.height = tall ? L.H * L.s + 'px' : '';
    const p = L.panel;
    Object.assign(panel.style, px({ left: p.x, top: p.y, width: p.w, height: p.h }));
    Object.assign(glow.style, px({ left: p.x, top: p.y, width: p.w, height: p.h }));
    traceSvg.setAttribute('width', L.W); traceSvg.setAttribute('height', L.H);
    for (const r of [trace, traceGlow]) for (const [k, v] of Object.entries({ x: p.x, y: p.y, width: p.w, height: p.h })) r.setAttribute(k, v);
    PERIM = 2 * (p.w + p.h);
    for (const r of [trace, traceGlow]) r.style.strokeDasharray = PERIM;
    Object.assign(heading.style, px(L.heading));
    Object.assign(statusEl.style, px(L.status));
    Object.assign(clockEl.style, px(L.clock));
    Object.assign(moreEl.style, px(L.more));
    FULL = { cx: L.W / 2, cy: L.H / 2, z: 1 };
    BEAMS.forEach((b) => { const x = (b.x * L.W) / 1920; b.d.style.left = x - 260 + 'px'; b.h.style.left = x - 26 + 'px'; });
    rows.forEach((r) => { r.el.style.scale = L.scale; if (r.slot >= 0) place(r, r.slot, false); });
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

  // ── baking: sample a function into keyframes and hand it to the compositor ──
  function track(list, el, t0, t1, fn, fps = 60) {
    const n = Math.max(2, Math.ceil((t1 - t0) * fps) + 1), kf = new Array(n);
    for (let k = 0; k < n; k++) kf[k] = fn(t0 + ((t1 - t0) * k) / (n - 1));
    const a = el.animate(kf, { duration: Math.max(1, (t1 - t0) * 1000), delay: t0 * 1000, fill: 'both', easing: 'linear' });
    list.push(a);
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
    const s = { ...cam }, A = [];
    track(A, camEl, 0, ms / 1000, (T) => { const e = eIO(T / (ms / 1000)); return { transform: camTransform({ cx: fl(s.cx, t.cx, e), cy: fl(s.cy, t.cy, e), z: fl(s.z, t.z, e) }) }; });
    startTogether(A);
    await A[0].finished.catch(() => {});
    Object.assign(cam, t); applyCam(); endAll(A);
  }

  // ── rows ──
  const rows = new Map(); // id -> row
  function buildRow(m) {
    const el = document.createElement('div');
    el.className = 'row';
    el.innerHTML = '<div class="card"><div class="blink"></div><div class="plate a"><i class="tint"></i><span class="name"></span></div>' +
      '<div class="plate b"><i class="tint"></i><span class="name"></span></div><div class="vs">V</div><div class="chip"></div>' +
      '<div class="note">Your match is about to start</div><div class="cdbar"><i></i></div><div class="flash"></div><div class="ring"></div></div>';
    const q = (s) => el.querySelector(s);
    const r = { el, m: null, slot: -1, chipKey: '', seenReady: 0, card: q('.card'), pa: q('.plate.a'), pb: q('.plate.b'), na: q('.a .name'), nb: q('.b .name'),
      vs: q('.vs'), chip: q('.chip'), bar: q('.cdbar i'), flash: q('.flash'), ring: q('.ring') };
    el.style.scale = L.scale;
    rowsEl.append(el);
    rows.set(m.id, r);
    paintRow(r, m, false);
    r.seenReady = m.readyAt || 0; // a row that is already "ready" when first drawn doesn't trigger the zoom
    return r;
  }
  function fitName(el) {
    let s = 38; el.style.fontSize = s + 'px';
    while (el.offsetWidth > 292 && s > 20) { s -= 2; el.style.fontSize = s + 'px'; }
  }
  function fmtLeft(at) {
    const s = Math.max(0, Math.ceil((at - GoatLive.now()) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function chipHTML(m) {
    const ct = m.court ? ` · COURT ${esc(m.court)}` : '';
    if (m.status === 'live') return m.ending ? `FINISHING${ct}` : `<span class="dot"></span>LIVE${ct}`;
    if (m.status === 'called') return `COURT ${esc(m.court)} · <span class="cd-label">STARTS IN</span> <span class="cd">${fmtLeft(m.callAt)}</span>`;
    if (m.ready) return `BE READY${m.readyCourt ? ' · COURT ' + esc(m.readyCourt) : ''}`;
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
    if (skipMotion()) { r.chip.innerHTML = r.chipHTML; return; }
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
    r.flash.animate([{ opacity: 0 }, { opacity: 0.85 }, { opacity: 0 }], { duration: 600 });
    r.ring.animate([{ opacity: 1, transform: 'scale(.3)' }, { opacity: 0, transform: 'scale(3.2)' }], { duration: 800, easing: 'cubic-bezier(.22,1,.36,1)' });
    r.card.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 500, easing: 'cubic-bezier(.2,1.4,.4,1)' });
  }
  function paintRow(r, m, animate = true) {
    if (animate && r.m && r.m.status !== 'live' && m.status === 'live') burst(r);
    if (!r.m || r.m.a !== m.a) { r.na.textContent = m.a || 'TBA'; fitName(r.na); }
    if (!r.m || r.m.b !== m.b) { r.nb.textContent = m.b || 'TBA'; fitName(r.nb); }
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
    r.el.style.translate = `${b.x}px ${b.y}px`;
    if (!animate) { void r.el.offsetWidth; r.el.style.transition = ''; }
    r.slot = slot;
  }

  // The original "slam" arrival (big → overshoot → settle, plates slide in, V punches, flash + ring), baked per row.
  function bakeSlam(A, r, te) {
    const D = 0.95, P = (dt) => fr(dt, 0, 0.6), slide = (dt) => 1 - eOut(fr(dt, 0, 0.35)), vP = (dt) => fr(dt, 0.12, 0.42);
    const sc = (p) => (p < 0.5 ? fl(1.6, 0.96, eOut(p / 0.5)) : p < 0.75 ? fl(0.96, 1.08, eOut((p - 0.5) / 0.25)) : fl(1.08, 1, eOut((p - 0.75) / 0.25)));
    track(A, r.card, te, te + D, (T) => { const dt = T - te; return { transform: `scale(${sc(P(dt))})`, opacity: fr(dt, 0, 0.12) }; });
    track(A, r.pa, te, te + D, (T) => ({ transform: `translateX(${-160 * slide(T - te)}px)` }));
    track(A, r.pb, te, te + D, (T) => ({ transform: `translateX(${160 * slide(T - te)}px)` }));
    track(A, r.vs, te, te + D, (T) => { const v = vP(T - te); return { transform: `scale(${fl(3, 1, eOut(v))})`, opacity: fc(v * 3) }; });
    track(A, r.chip, te, te + D, (T) => ({ transform: `translateY(${-30 * slide(T - te)}px)` }), 30);
    track(A, r.flash, te, te + D, (T) => { const dt = T - te; return { opacity: (1 - fr(dt, 0.3, 0.75)) * 0.85 * fc(P(dt) * 4) }; }, 30);
    track(A, r.ring, te, te + D, (T) => { const g = fr(T - te, 0.3, 0.9); return { opacity: g > 0 && g < 1 ? 1 - g : 0, transform: `scale(${fl(0.3, 3.2, eOut(g))})` }; });
  }
  async function slam(r) {
    r.card.style.opacity = '';
    if (skipMotion()) return;
    const A = [];
    bakeSlam(A, r, 0);
    startTogether(A);
    await A[0].finished.catch(() => {});
    endAll(A);
  }

  async function exitRow(r, ended) {
    rows.delete(r.m.id);
    if (skipMotion()) return r.el.remove();
    if (ended) {
      r.el.classList.remove('ending');
      r.el.classList.add('finished');
      r.chipHTML = 'FINISHED'; r.chipKey = 'FINISHED';
      flipChip(r);
      await sleep(650);
      r.flash.animate([{ opacity: 0 }, { opacity: 0.9 }, { opacity: 0 }], { duration: 520 });
      r.ring.animate([{ opacity: 1, transform: 'scale(.3)' }, { opacity: 0, transform: 'scale(3.2)' }], { duration: 700, easing: 'cubic-bezier(.22,1,.36,1)' });
      await r.card.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(1.05)', opacity: 1, offset: 0.3 }, { transform: 'scale(0.6)', opacity: 0 }],
        { duration: 800, delay: 120, easing: 'cubic-bezier(.55,0,.75,.2)', fill: 'forwards' }).finished;
    } else {
      await r.card.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(30px)' }],
        { duration: 420, easing: 'ease-in', fill: 'forwards' }).finished;
    }
    r.el.remove();
  }

  function spotlight(b) {
    if (skipMotion()) return;
    spot.style.translate = `${b.cx}px ${b.cy}px`;
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
    const vis = s.matches.slice(0, SLOTS);
    const ids = new Set(vis.map((m) => m.id));
    const doneIds = new Set((s.done || []).map((d) => d.id));
    vis.forEach((m) => { const r = rows.get(m.id); if (r) paintRow(r, m); });

    const exits = [...rows.values()].filter((r) => !ids.has(r.m.id));
    if (exits.length) await Promise.all(exits.map((r) => exitRow(r, doneIds.has(r.m.id))));

    let k = 0;
    vis.forEach((m, i) => { const r = rows.get(m.id); if (r && r.slot !== i) place(r, i, true, k++ * 55); });
    if (k && !skipMotion()) await sleep(900 + (k - 1) * 55);

    const rs = vis.map((m, i) => [m, i]).filter(([m]) => !rows.has(m.id))
      .map(([m, i]) => { const r = buildRow(m); place(r, i, false); r.card.style.opacity = 0; return r; });
    const camOk = !PREVIEW && !skipMotion();
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
      if (camOk) { await focusOn(r, 2200, async () => burst(r)); zoomed = true; }
    }
    if (zoomed) await camTo(FULL, 900);
  }

  // ── intro (same choreography as the original video), baked for the GPU ──
  let introAnims = [], introDone = null;
  function setFinal() {
    bgDark.style.opacity = 0; beamsEl.style.opacity = 0; panel.style.opacity = 1; glow.style.opacity = 0;
    trace.style.strokeDashoffset = 0; traceGlow.style.strokeDashoffset = 0;
    heading.style.opacity = 1; heading.style.transform = ''; chrome.style.opacity = 1;
    Object.assign(cam, FULL); applyCam();
  }
  function abortIntro() { if (introDone) introDone(); }
  function playIntro() {
    mode = 'intro';
    lastIntroAt = Date.now();
    rows.forEach((r) => r.el.remove()); rows.clear();
    const rs = latest.matches.slice(0, SLOTS).map((m, i) => { const r = buildRow(m); place(r, i, false); return r; });
    if (skipMotion()) { setFinal(); return Promise.resolve(); }
    const slot = 1.1, C = { Lights: 1, Matches: 3.6 };
    C.Reveal = C.Matches + Math.max(1, rs.length) * slot;
    const total = C.Reveal + 2.6;
    const A = (introAnims = []);
    const camAt = (T) => {
      if (rs.length && T >= C.Matches && T < C.Reveal) {
        const i = Math.min(rs.length - 1, Math.floor((T - C.Matches) / slot)), s0 = C.Matches + i * slot;
        const prev = i === 0 ? FULL : { ...slotBox(i - 1), z: L.dive }, cur = slotBox(i);
        const p = eIO(fr(T, s0, s0 + (i === 0 ? 0.6 : 0.38))), hit = s0 + 0.55;
        return { cx: fl(prev.cx, cur.cx, p), cy: fl(prev.cy, cur.cy, p), z: fl(prev.z, L.dive, p) - Math.sin(p * Math.PI) * (i === 0 ? 0 : 0.18 * (L.dive - 1) / 0.85),
          shake: T > hit ? Math.exp(-(T - hit) * 14) : 0 };
      }
      if (rs.length && T >= C.Reveal) {
        const last = slotBox(rs.length - 1), p = eIO(fr(T, C.Reveal, C.Reveal + 1.5));
        return { cx: fl(last.cx, FULL.cx, p), cy: fl(last.cy, FULL.cy, p), z: fl(L.dive, 1, p), shake: 0 };
      }
      return { ...FULL, shake: 0 };
    };
    track(A, camEl, 0, total, (T) => { const c = camAt(T); return { transform: camTransform(c, Math.sin(T * 90) * 9 * c.shake, Math.cos(T * 77) * 6 * c.shake) }; });
    const dark = (T) => 1 - eIO(fr(T, C.Reveal + 0.2, C.Reveal + 1.6));
    track(A, bgDark, 0, C.Reveal + 1.6, (T) => ({ opacity: dark(T) }), 30);
    track(A, beamsEl, 0, C.Reveal + 1.6, (T) => ({ opacity: dark(T) }), 30);
    BEAMS.forEach((b, i) => {
      const on = (T) => fr(T, C.Lights + i * 0.18, C.Lights + i * 0.18 + 0.12);
      track(A, b.d, 0, C.Reveal + 1.6, (T) => ({
        transform: `rotate(${fl(b.a0, b.a1, eIO(fr(T, C.Lights, C.Matches))) + Math.sin(T * 1.6 + b.ph) * 6}deg)`,
        opacity: on(T) * (0.85 + 0.15 * Math.sin(T * 9 + i)) }), 30);
      track(A, b.h, 0, C.Lights + 1, (T) => ({ opacity: on(T) }), 30);
    });
    track(A, panel, C.Lights + 0.9, C.Lights + 1.6, (T) => ({ opacity: eOut(fr(T, C.Lights + 0.9, C.Lights + 1.6)) }), 30);
    track(A, glow, C.Lights + 0.9, C.Reveal + 1.6, (T) => ({ opacity: eOut(fr(T, C.Lights + 0.9, C.Lights + 1.6)) * dark(T) }), 30);
    for (const r of [trace, traceGlow]) {
      A.push(r.animate([{ strokeDashoffset: PERIM }, { strokeDashoffset: 0 }], { duration: 1000, delay: (C.Lights + 0.5) * 1000, fill: 'both' }));
    }
    track(A, heading, C.Lights + 1.3, C.Lights + 1.9, (T) => {
      const hp = fr(T, C.Lights + 1.3, C.Lights + 1.9);
      return { opacity: fc(hp * 3), transform: `scale(${hp < 0.6 ? fl(1.5, 0.97, eOut(hp / 0.6)) : fl(0.97, 1, eOut((hp - 0.6) / 0.4))})` };
    });
    track(A, chrome, C.Reveal + 0.8, C.Reveal + 1.8, (T) => ({ opacity: fr(T, C.Reveal + 0.8, C.Reveal + 1.8) }), 30);
    track(A, sweepEl, C.Reveal + 1.4, C.Reveal + 2.4, (T) => ({ transform: `translateX(${fl(0, L.panel.w + 700, fr(T, C.Reveal + 1.4, C.Reveal + 2.4))}px) rotate(18deg)` }));
    rs.forEach((r, i) => bakeSlam(A, r, C.Matches + i * slot + 0.25));
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
    const extra = s.matches.length - SLOTS;
    moreEl.textContent = extra > 0 ? `+${extra} more match${extra > 1 ? 'es' : ''} in queue` : s.matches.length ? '' : 'Fixtures coming up shortly';
  }

  // ── boot ──
  lastW = innerWidth; lastH = innerHeight;
  applyLayout();
  bgDark.style.opacity = 1;
  const fontsOrTimeout = Promise.race([document.fonts.ready, sleep(1200)]); // never let slow font downloads delay the show

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

  document.fonts.ready.then(() => rows.forEach((r) => { fitName(r.na); fitName(r.nb); }));

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
