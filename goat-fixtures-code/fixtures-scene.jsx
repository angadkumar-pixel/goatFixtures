// THE GOAT Badminton Tournament — fixtures intro (animations-v3).
const FW = 1920, FH = 1080;
const fc = (v) => Math.max(0, Math.min(1, v));
const fr = (t, s, e) => fc((t - s) / (e - s));
const fl = (a, b, p) => a + (b - a) * p;
const eOut = Easing.easeOutCubic, eIO = Easing.easeInOutCubic;
const BLUE = '#022dc6', GOLD = '#fcc500', INK = '#060b26';
const LIGHT_BG = "radial-gradient(460px 460px at 260px 180px, rgba(27,54,200,0.20), transparent 68%), radial-gradient(430px 430px at 1750px 490px, rgba(201,214,255,0.85), transparent 70%), radial-gradient(470px 360px at 1240px 1100px, rgba(245,197,66,0.34), transparent 70%), #ffffff";

// Layout: panel + 2 columns x 5 rows
const PANEL = { x: 110, y: 40, w: 1700, h: 1000 };
const ROW = { w: 760, h: 112, top: 372, gap: 128, colX: [170, 990] };
function matchBox(i) {
  const col = i < 5 ? 0 : 1, row = i % 5;
  const x = ROW.colX[col], y = ROW.top + row * ROW.gap;
  return { x, y, cx: x + ROW.w / 2, cy: y + ROW.h / 2 };
}

function parseFixtures(t) {
  const out = [];
  for (let i = 1; i <= 10; i++) {
    const raw = t['m' + i] || '';
    const [time = '', a = '', b = ''] = raw.split('|').map((s) => s.trim());
    out.push({ time, a, b });
  }
  return out;
}

// Replay the intro on first open, or whenever the fixtures changed since the last view.
(function decideReplay() {
  try {
    const d = window.TWEAK_DEFAULTS || {};
    const sig = JSON.stringify(parseFixtures(d));
    const prev = localStorage.getItem('goat-fixtures-sig');
    const fresh = prev !== sig || new URLSearchParams(location.search).has('replay');
    localStorage.setItem('goat-fixtures-sig', sig);
    localStorage.setItem('animstage-v3:t', fresh ? '0' : '9999');
  } catch (e) {}
})();

function camera(T, C) {
  const full = { cx: 960, cy: 540, z: 1 };
  if (T < C.Matches) return { ...full, shake: 0 };
  const slot = (C.Reveal - C.Matches) / 10;
  if (T < C.Reveal) {
    const i = Math.min(9, Math.floor((T - C.Matches) / slot));
    const s0 = C.Matches + i * slot;
    const prev = i === 0 ? full : { ...matchBox(i - 1), z: 1.85 };
    const cur = matchBox(i);
    const p = eIO(fr(T, s0, s0 + (i === 0 ? 0.6 : 0.38)));
    const dip = Math.sin(p * Math.PI) * (i === 0 ? 0 : 0.18);
    const hit = s0 + 0.25 + 0.3;
    const sh = T > hit ? Math.exp(-(T - hit) * 14) : 0;
    return { cx: fl(prev.cx, cur.cx, p), cy: fl(prev.cy, cur.cy, p), z: fl(prev.z, 1.85, p) - dip, shake: sh };
  }
  const last = matchBox(9);
  const p = eIO(fr(T, C.Reveal, C.Reveal + 1.5));
  return { cx: fl(last.cx, 960, p), cy: fl(last.cy, 540, p), z: fl(1.85, 1, p), shake: 0 };
}

function Beams({ T, C, o }) {
  if (o <= 0.001) return null;
  const sweep = fr(T, C.Lights, C.Matches);
  const beams = [
    { x: 260, c: 'rgba(80,130,255,', a0: 35, a1: -25, ph: 0 },
    { x: 700, c: 'rgba(255,214,90,', a0: -30, a1: 20, ph: 1 },
    { x: 1220, c: 'rgba(255,214,90,', a0: 30, a1: -20, ph: 2 },
    { x: 1660, c: 'rgba(80,130,255,', a0: -35, a1: 25, ph: 3 },
  ];
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: o, pointerEvents: 'none', mixBlendMode: 'screen' }}>
      {beams.map((b, i) => {
        const on = fr(T, C.Lights + i * 0.18, C.Lights + i * 0.18 + 0.12);
        const a = fl(b.a0, b.a1, eIO(sweep)) + Math.sin(T * 1.6 + b.ph) * 6;
        return <div key={i} style={{ position: 'absolute', left: b.x - 260, top: -40, width: 520, height: 1400, transformOrigin: '50% 0',
          transform: `rotate(${a}deg)`, opacity: on * (0.85 + 0.15 * Math.sin(T * 9 + i)),
          clipPath: 'polygon(46% 0, 54% 0, 100% 100%, 0 100%)',
          background: `linear-gradient(180deg, ${b.c}0.75) 0%, ${b.c}0.22) 55%, ${b.c}0) 100%)` }} />;
      })}
      {beams.map((b, i) => (
        <div key={'h' + i} style={{ position: 'absolute', left: b.x - 26, top: -26, width: 52, height: 52, borderRadius: '50%',
          background: '#fff', boxShadow: `0 0 40px 14px ${b.c}0.8)`, opacity: fr(T, C.Lights + i * 0.18, C.Lights + i * 0.18 + 0.12) }} />
      ))}
    </div>
  );
}

function Match({ T, m, i, te }) {
  const b = matchBox(i);
  const p = fr(T, te, te + 0.6);
  if (p <= 0) return null;
  // bold arrival: big → overshoot → settle
  const sc = p < 0.5 ? fl(1.6, 0.96, eOut(p / 0.5)) : p < 0.75 ? fl(0.96, 1.08, eOut((p - 0.5) / 0.25)) : fl(1.08, 1, eOut((p - 0.75) / 0.25));
  const op = fr(T, te, te + 0.12);
  const slide = 1 - eOut(fr(T, te, te + 0.35));
  const vP = fr(T, te + 0.12, te + 0.42);
  const vS = fl(3, 1, eOut(vP));
  const flash = 1 - fr(T, te + 0.3, te + 0.75);
  const ring = fr(T, te + 0.3, te + 0.9);
  const name = { fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 700, fontSize: 38, lineHeight: 1, letterSpacing: 1.5,
    textTransform: 'uppercase', color: '#fff', textWrap: 'balance' };
  return (
    <div style={{ position: 'absolute', left: b.x, top: b.y, width: ROW.w, height: ROW.h, transform: `scale(${sc})`, opacity: op }}>
      <div style={{ position: 'absolute', left: 0, top: 30, width: 368, height: 82, transform: `translateX(${-160 * slide}px)`,
        background: INK, clipPath: 'polygon(0 0, 100% 0, calc(100% - 26px) 100%, 0 100%)',
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '0 52px 0 22px', boxSizing: 'border-box', textAlign: 'right' }}>
        <span style={name}>{m.a}</span>
      </div>
      <div style={{ position: 'absolute', right: 0, top: 30, width: 368, height: 82, transform: `translateX(${160 * slide}px)`,
        background: INK, clipPath: 'polygon(26px 0, 100% 0, 100% 100%, 0 100%)',
        display: 'flex', alignItems: 'center', justifyContent: 'flex-start', padding: '0 22px 0 52px', boxSizing: 'border-box' }}>
        <span style={name}>{m.b}</span>
      </div>
      <div style={{ position: 'absolute', left: 330, top: 30, width: 100, height: 82, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: "'Anton',sans-serif", fontSize: 58, lineHeight: 1, color: GOLD, transform: `scale(${vS})`, opacity: fc(vP * 3),
        textShadow: '0 0 18px rgba(252,197,0,0.55)' }}>V</div>
      {m.time && <div style={{ position: 'absolute', left: 310, top: 0, width: 140, height: 40, borderRadius: 8, background: GOLD,
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 700,
        fontSize: 28, letterSpacing: 1, color: INK, transform: `translateY(${-30 * slide}px)`, boxShadow: '0 6px 14px rgba(1,10,58,0.35)' }}>{m.time}</div>}
      {flash > 0 && <div style={{ position: 'absolute', left: 0, top: 30, width: ROW.w, height: 82, background: '#fff', opacity: flash * 0.85 * fc(p * 4),
        mixBlendMode: 'screen' }} />}
      {ring > 0 && ring < 1 && <div style={{ position: 'absolute', left: ROW.w / 2 - 70, top: 71 - 70, width: 140, height: 140, borderRadius: '50%',
        border: `5px solid ${GOLD}`, transform: `scale(${fl(0.3, 3.2, eOut(ring))})`, opacity: 1 - ring, boxShadow: '0 0 30px rgba(252,197,0,0.7)' }} />}
    </div>
  );
}

function FixturesPiece({ fixtures, title, subtitle }) {
  const { T, CUES: C } = useComposition();
  const cam = camera(T, C);
  const dark = 1 - eIO(fr(T, C.Reveal + 0.2, C.Reveal + 1.6));
  const panelOn = eOut(fr(T, C.Lights + 0.9, C.Lights + 1.6));
  const trace = fr(T, C.Lights + 0.5, C.Lights + 1.5);
  const headP = fr(T, C.Lights + 1.3, C.Lights + 1.9);
  const headSc = headP < 0.6 ? fl(1.5, 0.97, eOut(headP / 0.6)) : fl(0.97, 1, eOut((headP - 0.6) / 0.4));
  const slot = (C.Reveal - C.Matches) / 10;
  const sweep = fr(T, C.Reveal + 1.4, C.Reveal + 2.4);
  const shx = Math.sin(T * 90) * 9 * cam.shake, shy = Math.cos(T * 77) * 6 * cam.shake;
  const perim = 2 * (PANEL.w + PANEL.h);
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: LIGHT_BG }}>
      <div style={{ position: 'absolute', inset: 0, opacity: dark, background: 'radial-gradient(1400px 800px at 50% 30%, #0d1440 0%, #04061a 50%, #000 100%)' }} />
      <Beams T={T} C={C} o={dark} />
      <div style={{ position: 'absolute', left: 0, top: 0, width: FW, height: FH, transformOrigin: '0 0',
        transform: `translate(${960 - cam.cx * cam.z + shx}px, ${540 - cam.cy * cam.z + shy}px) scale(${cam.z})` }}>
        <div style={{ position: 'absolute', left: PANEL.x, top: PANEL.y, width: PANEL.w, height: PANEL.h, borderRadius: 36, overflow: 'hidden',
          opacity: panelOn, background: `linear-gradient(160deg, #1550ff 0%, ${BLUE} 45%, #011a86 100%)`,
          boxShadow: `0 40px 80px rgba(1,10,58,0.35), 0 0 ${120 * dark}px rgba(80,130,255,${0.5 * dark})` }}>
          <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(135deg, rgba(255,255,255,0.035) 0 60px, rgba(255,255,255,0) 60px 140px)' }} />
          {sweep > 0 && sweep < 1 && <div style={{ position: 'absolute', top: -200, bottom: -200, width: 260, left: fl(-400, PANEL.w + 200, sweep),
            transform: 'rotate(18deg)', background: 'linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,0.22), rgba(255,255,255,0))' }} />}
        </div>
        <svg width={FW} height={FH} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}>
          <rect x={PANEL.x} y={PANEL.y} width={PANEL.w} height={PANEL.h} rx="36" fill="none" stroke={GOLD} strokeWidth="4"
            strokeDasharray={perim} strokeDashoffset={perim * (1 - trace)} style={{ filter: 'drop-shadow(0 0 10px rgba(252,197,0,0.8))' }} />
        </svg>
        <div style={{ position: 'absolute', left: PANEL.x, width: PANEL.w, top: 92, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
          opacity: fc(headP * 3), transform: `scale(${headSc})` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 24, fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 700, fontSize: 36,
            letterSpacing: 12, color: GOLD, textTransform: 'uppercase' }}>
            <span style={{ width: 110, height: 2, background: `linear-gradient(90deg, rgba(252,197,0,0), ${GOLD})` }}></span>
            <span style={{ marginRight: -12 }}>{title}</span>
            <span style={{ width: 110, height: 2, background: `linear-gradient(90deg, ${GOLD}, rgba(252,197,0,0))` }}></span>
          </div>
          <div style={{ fontFamily: "'Anton',sans-serif", fontSize: 150, lineHeight: 1, letterSpacing: 14, marginRight: -14, color: '#fff',
            textShadow: `5px 6px 0 ${INK}` }}>FIXTURES</div>
          <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 600, fontSize: 32, letterSpacing: 10, marginRight: -10,
            color: '#fff', textTransform: 'uppercase', opacity: 0.92 }}>{subtitle}</div>
        </div>
        {fixtures.map((m, i) => <Match key={i} T={T} m={m} i={i} te={C.Matches + i * slot + 0.25} />)}
      </div>
    </div>
  );
}

const FQ = new URLSearchParams(location.search);
const FBROADCAST = FQ.has('obs');

function FixturesVideo() {
  const [t, setTweak] = useTweaks(window.TWEAK_DEFAULTS);
  const fixtures = parseFixtures(t);
  React.useEffect(() => {
    if (!FBROADCAST) return;
    const id = setInterval(() => {
      const root = document.querySelector('[data-om-starter="animations-v3"]');
      if (!root) return;
      root.style.background = 'transparent';
      Array.from(root.children).forEach((c, i) => { if (i > 0) c.style.display = 'none'; });
    }, 200);
    return () => clearInterval(id);
  }, []);
  return (
    <React.Fragment>
      <CompositionStage width={FW} height={FH} bg="#000000" scenes={window.OM_SCENES} playback={window.OM_PLAYBACK}>
        <FixturesPiece fixtures={fixtures} title={t.title || ''} subtitle={t.subtitle || ''} />
      </CompositionStage>
      <TweaksPanel>
        <TweakSection label="Heading" />
        <TweakText label="Tournament" value={t.title} onChange={(v) => setTweak('title', v)} />
        <TweakText label="Subtitle" value={t.subtitle} onChange={(v) => setTweak('subtitle', v)} />
        <TweakSection label="Matches — time | player A | player B" />
        {Array.from({ length: 10 }).map((_, i) => (
          <TweakText key={i} label={'Match ' + (i + 1)} value={t['m' + (i + 1)]} onChange={(v) => setTweak('m' + (i + 1), v)} />
        ))}
      </TweaksPanel>
    </React.Fragment>
  );
}

window.FixturesVideo = FixturesVideo;
