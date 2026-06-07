// launch-home-orbit.jsx — hero orbital for the landing page.
// Agents drift on their own tilted elliptical orbits (solar-system style) around
// an empty centre. Each icon rides a CSS offset-path ellipse, staying upright.

const OB = window.LaunchData.L;

// Build an SVG path string for a tilted ellipse centred at (cx,cy).
function ellipsePath(cx, cy, rx, ry, tilt, n = 80) {
  const t = (tilt * Math.PI) / 180, ct = Math.cos(t), st = Math.sin(t);
  let d = '';
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    const ex = rx * Math.cos(a), ey = ry * Math.sin(a);
    const x = cx + ex * ct - ey * st;
    const y = cy + ex * st + ey * ct;
    d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2) + ' ';
  }
  return d + 'Z';
}

function OrbitAgent({ path, dur, start, src, px, dir = 1 }) {
  const uid = React.useMemo(() => 'oa' + Math.random().toString(36).slice(2, 8), []);
  const delay = (start / 100) * dur;
  return (
    <React.Fragment>
      <style>{`
        @keyframes ${uid}-run { from { offset-distance: 0%; } to { offset-distance: ${dir > 0 ? 100 : -100}%; } }
        .${uid} { position: absolute; left: 0; top: 0; width: ${px}px; height: ${px}px;
          offset-path: path('${path}'); offset-rotate: 0deg; offset-anchor: 50% 50%; offset-distance: ${start}%; }
        @media (prefers-reduced-motion: no-preference) {
          .${uid} { animation: ${uid}-run ${dur}s linear infinite; animation-delay: -${delay}s; }
        }
      `}</style>
      <img className={uid} src={src} alt="" width={px} height={px} style={{ display: 'block', objectFit: 'contain' }}/>
    </React.Fragment>
  );
}

function OrbitalSystem({ size = 440 }) {
  const c = size / 2;
  const tilt = -18, ratio = 0.5;
  const orbits = [
    { f: 0.22, dur: 44, start: 14, src: 'agent-codex.png', px: 24, dir: 1 },
    { f: 0.31, dur: 58, start: 58, src: 'agent-cursor.png', px: 26, dir: -1 },
    { f: 0.385, dur: 74, start: 80, src: 'agent-openclaw.png', px: 26, dir: 1 },
    { f: 0.46, dur: 92, start: 36, src: 'agent-claude.png', px: 30, dir: -1 },
  ].map((o) => { const rx = o.f * size; return { ...o, rx, ry: rx * ratio, path: ellipsePath(c, c, rx, rx * ratio, tilt) }; });
  return (
    <div style={{ position: 'relative', width: size, height: size, margin: '0 auto', maxWidth: '100%', overflow: 'visible' }}>
      {/* Orbit ellipses */}
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ position: 'absolute', inset: 0, display: 'block', overflow: 'visible' }}>
        {orbits.map((o, i) => <path key={i} d={o.path} fill="none" stroke="rgba(0,0,0,0.11)" strokeWidth="1"/>)}
      </svg>
      {/* Drifting agents, each on its own ellipse */}
      {orbits.map((o, i) => <OrbitAgent key={i} path={o.path} dur={o.dur} start={o.start} src={o.src} px={o.px} dir={o.dir}/>)}
    </div>
  );
}

window.LaunchHomeOrbit = { OrbitalSystem };
