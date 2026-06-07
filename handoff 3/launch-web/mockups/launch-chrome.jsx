// launch-chrome.jsx — frames (browser / phone), nav shells, and shared atoms.
// Pure Ultralight monochrome. Consumes window.LaunchData + window.PUI_Icons.

const { L: LC, CAP_COLORS: LCAP_C, CAP_GLYPH: LCAP_G, fmtLight: lcFmtLight, sparkPoints: lcSpark } = window.LaunchData;
const LI = window.PUI_Icons;

// ── Extra icons (1.5 stroke, matching PUI set) ────────────────────────────────
const LIcon = ({ children, size = 16, sw = 1.5, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" {...p}>{children}</svg>
);
const IconCopy = (p) => <LIcon {...p}><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></LIcon>;
const IconExternal = (p) => <LIcon {...p}><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></LIcon>;
const IconShield = (p) => <LIcon {...p}><path d="M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z"/><path d="M9 12l2 2 4-4"/></LIcon>;
const IconTerminal = (p) => <LIcon {...p}><polyline points="6 8 10 12 6 16"/><line x1="12" y1="16" x2="18" y2="16"/></LIcon>;
const IconClose = (p) => <LIcon {...p} sw={1.8}><path d="M6 6l12 12M18 6L6 18"/></LIcon>;
const IconArrowRight = (p) => <LIcon {...p} sw={1.8}><path d="M5 12h14M13 6l6 6-6 6"/></LIcon>;
const IconGrid = (p) => <LIcon {...p}><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></LIcon>;
const IconMenu = (p) => <LIcon {...p} sw={1.8}><path d="M3 6h18M3 12h18M3 18h18"/></LIcon>;
const IconCircuit = (p) => <LIcon {...p}><circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 6h8M6 8v8a2 2 0 0 0 2 2h8"/></LIcon>;

// ── Brand spark glyph (filled 8-point star, like premium primitives) ──────────
function LSpark({ size = 16, color = LC.text }) {
  const r = 8, k = 0.28, cx = 12, cy = 12;
  const pts = [[cx, cy - r], [cx + r * k, cy - r * k], [cx + r, cy], [cx + r * k, cy + r * k],
    [cx, cy + r], [cx - r * k, cy + r * k], [cx - r, cy], [cx - r * k, cy - r * k]].map((p) => p.join(',')).join(' ');
  return <svg width={size} height={size} viewBox="0 0 24 24"><polygon points={pts} fill={color}/></svg>;
}
// ── EclipseU — the locked eclipse-U brand mark (crescent of light bent into a U).
//    Cropped to its silhouette so the rendered box == the visible ink.
function LEclipseU({ height = 16, color = LC.text, style }) {
  const w = Math.max(1, Math.round(height * 168 / 144));
  const uid = 'leu' + React.useId().replace(/:/g, '');
  return (
    <svg width={w} height={height} viewBox="44 56 168 144" style={{ display: 'inline-block', verticalAlign: 'baseline', ...style }} shapeRendering="geometricPrecision">
      <mask id={uid} maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="256">
        <rect x="0" y="0" width="256" height="256" fill="black"/>
        <circle cx="128" cy="116.02" r="84" fill="white"/>
        <circle cx="128" cy="98.02" r="72.24" fill="black"/>
      </mask>
      <circle cx="128" cy="116.02" r="84" fill={color} mask={`url(#${uid})`}/>
    </svg>
  );
}

// ── Wordmark — EclipseU + "Ultralight" in Newsreader light italic (the locked logo).
function LWordmark({ size = 16, color = LC.text }) {
  const fs = Math.round(size * 1.08);
  const capH = Math.round(fs * 0.70);
  const gap = Math.round(fs * 0.32);
  const rise = (-fs * 0.06).toFixed(2) + 'px';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap', color }}>
      <span style={{ display: 'inline-flex', marginRight: gap, transform: `translateY(${rise})` }}>
        <LEclipseU height={capH} color={color} style={{ display: 'block', verticalAlign: 'top' }}/>
      </span>
      <span style={{ fontFamily: "'Newsreader', serif", fontWeight: 400, fontStyle: 'italic', fontSize: fs, letterSpacing: 0, lineHeight: 1, transform: 'translateY(1px)' }}>Ultralight</span>
    </span>
  );
}

// ── Avatar (initial circle) ───────────────────────────────────────────────────
function LAvatar({ name, color, size = 24 }) {
  const ch = (name || '?').replace('@', '').slice(0, 1).toUpperCase();
  return (
    <span style={{ width: size, height: size, borderRadius: 9999, background: color || '#d1d5db', color: '#fff',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.42, fontWeight: 600, flexShrink: 0 }}>{ch}</span>
  );
}

// ── Sparkline ─────────────────────────────────────────────────────────────────
function LSparkline({ data, w = 56, h = 16, growth = 0 }) {
  const stroke = growth > 0.05 ? LC.green : growth < -0.05 ? LC.red : LC.mute;
  return (
    <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
      <polyline points={lcSpark(data, w, h)} fill="none" stroke={stroke} strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" opacity="0.9"/>
    </svg>
  );
}

// ── Mono text + small label + pill ─────────────────────────────────────────────
function LMono({ children, size = 12, color = LC.text, weight = 500, style }) {
  return <span style={{ fontFamily: LC.mono, fontSize: size, color, fontWeight: weight, fontVariantNumeric: 'tabular-nums', ...style }}>{children}</span>;
}
function LLabel({ children, color = LC.mute, mb = 10, style }) {
  return <div style={{ fontFamily: LC.mono, fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color, marginBottom: mb, ...style }}>{children}</div>;
}
function LKindBadge({ kind }) {
  return <span style={{ fontFamily: LC.mono, fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: LC.sec, border: `1px solid ${LC.border}`, background: LC.raised, padding: '2px 6px', borderRadius: 4 }}>{kind}</span>;
}

// ── Trust stamp (three green dots = signed manifest + receipts) ───────────────
function LTrustStamp({ size = 5, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title="Signed manifest · receipts on">
      <span style={{ display: 'inline-flex', gap: 3 }}>
        {[0, 1, 2].map((i) => <span key={i} style={{ width: size, height: size, borderRadius: 9999, background: '#16a34a' }}/>)}
      </span>
      {label && <span style={{ fontSize: 12, color: LC.sec }}>{label}</span>}
    </span>
  );
}

// ── Capability pill ────────────────────────────────────────────────────────────
function LCapPill({ cap }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: LC.raised, border: `1px solid ${LC.border}`, borderRadius: 8 }}>
      <LMono size={11} color={LCAP_C[cap.kind]} weight={600}>{LCAP_G[cap.kind]} {cap.kind}</LMono>
      <span style={{ fontSize: 12.5, color: LC.sec }}>{cap.what}</span>
    </div>
  );
}

// ── Buttons ──────────────────────────────────────────────────────────────────
function LBtn({ children, kind = 'secondary', size = 'md', onClick, full, style }) {
  const pad = size === 'lg' ? '12px 20px' : size === 'sm' ? '6px 12px' : '9px 15px';
  const fs = size === 'lg' ? 14 : size === 'sm' ? 12 : 13;
  const base = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: pad, fontSize: fs, fontWeight: 500, fontFamily: LC.font, borderRadius: size === 'lg' ? 10 : 8, cursor: 'pointer', width: full ? '100%' : undefined, transition: 'all 160ms ease', boxSizing: 'border-box', whiteSpace: 'nowrap' };
  const kinds = {
    primary: { background: LC.text, color: '#fff', border: 'none' },
    secondary: { background: '#fff', color: LC.text, border: `1px solid ${LC.borderStrong}` },
    ghost: { background: 'transparent', color: LC.sec, border: 'none' },
  };
  // Newsreader sits ~1px high in a centered line box — nudge the label down to optically center it.
  return <button onClick={onClick} style={{ ...base, ...kinds[kind], ...style }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, transform: 'translateY(0.5px)' }}>{children}</span></button>;
}

// ── Brand logos for the "works with" wall (monochrome, currentColor) ──────────
function LogoMark({ id, size = 18 }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' };
  switch (id) {
    case 'claude': // Anthropic-style burst
      return <svg {...p} stroke="none" fill="currentColor"><g>{Array.from({ length: 8 }).map((_, i) => { const a = (i * Math.PI) / 4; return <rect key={i} x="11.1" y="3.5" width="1.8" height="7" rx="0.9" transform={`rotate(${i * 45} 12 12)`}/>; })}</g></svg>;
    case 'cursor': // tilted cube
      return <svg {...p}><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 3v18M4 7.5l8 4.5 8-4.5"/></svg>;
    case 'codex': // > _ terminal in rounded square
      return <svg {...p}><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 10l2.5 2L8 14M13 15h3"/></svg>;
    case 'openai': // six-node ring
      return <svg {...p} strokeWidth="1.4"><g>{Array.from({ length: 6 }).map((_, i) => { const a = (i * Math.PI) / 3 - Math.PI / 2; return <circle key={i} cx={12 + 7 * Math.cos(a)} cy={12 + 7 * Math.sin(a)} r="2.1"/>; })}</g></svg>;
    case 'mcp': // hex node + connectors
      return <svg {...p}><path d="M12 3l7 4v8l-7 4-7-4V7z"/><circle cx="12" cy="12" r="2.2"/><path d="M12 7v2.8M14 13.2l2.4 1.4M10 13.2l-2.4 1.4"/></svg>;
    case 'cli': // >_
      return <svg {...p}><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 10l2.5 2L7 14M13 14.5h4"/></svg>;
    case 'api': // </>
      return <svg {...p}><path d="M8.5 8L4 12l4.5 4M15.5 8L20 12l-4.5 4M13.5 6l-3 12"/></svg>;
    default: return null;
  }
}
const LOGO_LABELS = { claude: 'Claude Code', cursor: 'Cursor', codex: 'Codex', openai: 'OpenAI', mcp: 'MCP', cli: 'CLI', api: 'API' };
function LogoLockup({ id, color = '#8a8a8a' }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color }}>
      <LogoMark id={id} size={18}/>
      <span style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: '-0.01em', color }}>{LOGO_LABELS[id]}</span>
    </span>
  );
}
function LogoWall({ ids = ['claude', 'cursor', 'codex', 'openai', 'mcp', 'cli', 'api'], label = 'Works with', gap = 20 }) {
  return (
    <div style={{ display: 'flex', gap, flexWrap: 'wrap', alignItems: 'center' }}>
      {label && <LMono size={11} color={LC.mute} style={{ letterSpacing: '0.08em', textTransform: 'uppercase', marginRight: 2 }}>{label}</LMono>}
      {ids.map((id) => <LogoLockup key={id} id={id}/>)}
    </div>
  );
}

// ── "Agent instruction copied" toast ─────────────────────────────────────────
// Anchored to the clicked artboard's frame so it appears inside the mockup screen.
function showToast(e, html) {
  const host = (e && e.currentTarget && e.currentTarget.closest('[data-screen-frame]')) || document.body;
  const inFrame = host !== document.body;
  host.querySelectorAll('.__ul_agent_toast').forEach((n) => n.remove());
  const el = document.createElement('div');
  el.className = '__ul_agent_toast';
  el.style.cssText = [
    inFrame ? 'position:absolute' : 'position:fixed', 'left:50%', 'bottom:24px', 'transform:translateX(-50%) translateY(12px)',
    'z-index:9999', 'display:flex', 'align-items:center', 'gap:10px',
    'padding:12px 16px', 'border-radius:12px', 'background:#0a0a0a', 'color:#fff',
    "font-family:'Newsreader',Georgia,serif", 'font-size:13.5px', 'font-weight:500',
    'box-shadow:0 12px 40px rgba(0,0,0,0.28)', 'opacity:0', 'transition:opacity 220ms ease, transform 220ms ease',
    'pointer-events:none', 'max-width:340px', 'white-space:nowrap',
  ].join(';');
  el.innerHTML = '<span style="display:inline-flex;width:22px;height:22px;border-radius:9999px;background:#16a34a;align-items:center;justify-content:center;flex-shrink:0">'
    + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></span>'
    + '<span>' + html + '</span>';
  host.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateX(-50%) translateY(0)'; });
  setTimeout(() => {
    el.style.opacity = '0'; el.style.transform = 'translateX(-50%) translateY(12px)';
    setTimeout(() => el.remove(), 260);
  }, 2600);
}
function showAgentToast(e) {
  showToast(e, 'Agent instruction copied. <span style="color:#9ca3af">Paste to your agent!</span>');
}

// ── Primary CTA — one button, everywhere ──────────────────────────────────────
function CopyAgentBtn({ size = 'sm', short = false, full = false, style, deploy = false }) {
  if (deploy) {
    return (
      <LBtn kind="primary" size={size} full={full} style={style}>
        Deploy docs
      </LBtn>
    );
  }
  return (
    <LBtn kind="primary" size={size} full={full} style={style} onClick={(e) => showAgentToast(e)}>
      <IconCopy size={size === 'lg' ? 16 : 14}/>Add to agent
    </LBtn>
  );
}

// ── Profile cluster (signed-in right side) ────────────────────────────────────
function ProfileCluster({ balance = 12.40, size = 28, showBalance = true }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      {showBalance && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: LC.mono, fontSize: 13, color: LC.text, border: `1px solid ${LC.border}`, borderRadius: 9999, padding: '5px 11px', cursor: 'pointer' }}>✦{lcFmtLight(balance)}</span>}
      <span title="Profile" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
        <LAvatar name="@you" color="#0a0a0a" size={size}/>
        <span style={{ color: LC.mute, fontSize: 10 }}>▾</span>
      </span>
    </span>
  );
}

// ── Top nav (desktop web shell) ───────────────────────────────────────────────
function LTopNav({ active = 'store', signedIn = false, balance = 12.40, cta = true, showBalance = true }) {
  const links = [{ id: 'library', label: 'Library' }, { id: 'store', label: 'Store' }, { id: 'wallet', label: 'Wallet' }];
  return (
    <div style={{ height: 60, flexShrink: 0, position: 'sticky', top: 0, zIndex: 20, background: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', padding: '0 28px' }}>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', minWidth: 0 }}>
        <LWordmark size={20}/>
      </div>
      <div style={{ display: 'flex', gap: 10, transform: 'translateY(2px)' }}>
        {links.map((n) => (
          <span key={n.id} style={{ fontFamily: LC.font, fontSize: 15.5, fontWeight: active === n.id ? 700 : 500, letterSpacing: '0.01em', color: LC.text, padding: '6px 8px', cursor: 'pointer', textDecoration: active === n.id ? 'underline' : 'none', textUnderlineOffset: 5, textDecorationThickness: 1.5 }}>{n.label}</span>
        ))}
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 16 }}>
        {cta && <CopyAgentBtn style={{ fontFamily: LC.font }} deploy={signedIn && balance > 0 && active !== 'home'}/>}
        {signedIn
          ? <ProfileCluster balance={balance} showBalance={showBalance}/>
          : <span style={{ fontFamily: LC.font, fontSize: 15.5, fontWeight: 500, color: LC.sec, cursor: 'pointer', transform: 'translateY(0.5px)' }}>Sign in</span>}
      </div>
    </div>
  );
}

// ── Mobile top bar ─────────────────────────────────────────────────────────────
function LMobileBar({ signedIn = false, balance = 12.40, title, cta = true }) {
  return (
    <div style={{ height: 52, flexShrink: 0, borderBottom: `1px solid ${LC.border}`, display: 'flex', alignItems: 'center', gap: 12, padding: '0 16px', background: '#fff' }}>
      <span style={{ color: LC.text, display: 'inline-flex' }}><IconMenu size={20}/></span>
      {title ? <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</span> : <LWordmark size={18}/>}
      <div style={{ flex: 1 }}/>
      {signedIn
        ? <span style={{ fontFamily: LC.mono, fontSize: 12.5, border: `1px solid ${LC.border}`, borderRadius: 9999, padding: '4px 9px' }}>✦{lcFmtLight(balance)}</span>
        : (cta ? <LBtn kind="primary" size="sm" onClick={(e) => showAgentToast(e)}><IconCopy size={13}/>Add</LBtn> : null)}
    </div>
  );
}

// ── Browser window frame (desktop web) ─────────────────────────────────────────
function BrowserFrame({ url = 'ultralight.dev', width = 1280, height = 860, children }) {
  return (
    <div data-screen-frame="1" style={{ width, height, display: 'flex', flexDirection: 'column', background: '#fff', overflow: 'hidden', position: 'relative' }}>
      <div style={{ height: 40, flexShrink: 0, background: '#f1f1ef', borderBottom: `1px solid ${LC.border}`, display: 'flex', alignItems: 'center', gap: 14, padding: '0 14px' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {['#ec6a5e', '#f4bf4f', '#61c554'].map((c) => <span key={c} style={{ width: 12, height: 12, borderRadius: 9999, background: c }}/>)}
        </div>
        <div style={{ flex: 1, maxWidth: 560, margin: '0 auto', height: 26, borderRadius: 7, background: '#fff', border: `1px solid ${LC.border}`, display: 'flex', alignItems: 'center', gap: 7, padding: '0 11px' }}>
          <span style={{ color: LC.mute, display: 'inline-flex' }}><IconShield size={12}/></span>
          <LMono size={12} color={LC.sec}>{url}</LMono>
        </div>
        <div style={{ width: 52 }}/>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{children}</div>
    </div>
  );
}

// ── Phone frame (mobile web) ────────────────────────────────────────────────────
function PhoneFrame({ width = 390, height = 844, children }) {
  return (
    <div data-screen-frame="1" style={{ width, height, display: 'flex', flexDirection: 'column', background: '#fff', overflow: 'hidden', position: 'relative' }}>
      <div style={{ height: 44, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 22px', fontSize: 13, fontWeight: 600, color: LC.text }}>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>9:41</span>
        <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
          <svg width="17" height="11" viewBox="0 0 17 11" fill={LC.text}><rect x="0" y="6" width="3" height="5" rx="1"/><rect x="4.5" y="3.5" width="3" height="7.5" rx="1"/><rect x="9" y="1" width="3" height="10" rx="1"/><rect x="13.5" y="0" width="3" height="11" rx="1" opacity="0.3"/></svg>
          <svg width="22" height="11" viewBox="0 0 24 12" fill="none"><rect x="1" y="1" width="20" height="10" rx="2.5" stroke={LC.text} opacity="0.4"/><rect x="2.5" y="2.5" width="15" height="7" rx="1.3" fill={LC.text}/><rect x="22" y="4" width="1.5" height="4" rx="0.7" fill={LC.text} opacity="0.4"/></svg>
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{children}</div>
      <div style={{ height: 22, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ width: 134, height: 5, borderRadius: 9999, background: LC.text, opacity: 0.85 }}/>
      </div>
    </div>
  );
}

// ── Scroll region (page body inside a frame) ────────────────────────────────────
function LScroll({ children, style }) {
  return <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', ...style }}>{children}</div>;
}

window.LaunchChrome = {
  LSpark, LEclipseU, LWordmark, LAvatar, LSparkline, LMono, LLabel, LKindBadge, LTrustStamp,
  LCapPill, LBtn, LTopNav, LMobileBar, BrowserFrame, PhoneFrame, LScroll,
  LogoMark, LogoLockup, LogoWall, CopyAgentBtn, ProfileCluster, showToast, showAgentToast,
  IconCopy, IconExternal, IconShield, IconTerminal, IconClose, IconArrowRight, IconGrid, IconMenu, IconCircuit,
};
