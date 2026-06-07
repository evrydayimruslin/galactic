// launch-home.jsx — Launch home / (desktop + mobile).
// Backend: GET /api/launch/status (thesis, capabilities, externalAgentLoop, links),
//   GET /api/launch/install (config preview), GET /api/launch/platform-primitives,
//   GET /api/launch/leaderboard?kind=builder (builders teaser).

const { L: H, MCP_URL: H_MCP, PRIMITIVES: H_PRIM, LEADERBOARD_BUILDER: H_LB, DISCOVER_TOOLS: H_TOOLS, fmtN: hN, fmtLight: hLight } = window.LaunchData;
const HC = window.LaunchChrome;
const {
  LWordmark: H_Word, LMono: H_Mono, LLabel: H_Label, LBtn: H_Btn, LAvatar: H_Avatar, LSparkline: H_Spark, LKindBadge: H_Kind,
  LTopNav: H_TopNav, LMobileBar: H_Bar, BrowserFrame: H_Browser, PhoneFrame: H_Phone, LScroll: H_Scroll,
  IconArrowRight: H_Arr, IconCircuit: H_Circ, IconTerminal: H_Term, IconGrid: H_GridI, IconExternal: H_Ext,
} = window.LaunchChrome;

const LOOP = ['Install MCP / CLI / API', 'Discover tools + primitives', 'Inspect pricing, trust, widgets', 'Call through MCP / API', 'Return widget links + receipts'];

function ConfigPreview() {
  return (
    <div style={{ borderRadius: 12, overflow: 'hidden', border: `1px solid ${H.borderStrong}`, boxShadow: '0 8px 30px rgba(0,0,0,0.10)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 13px', background: '#0b1220', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ display: 'flex', gap: 6 }}>{['#ec6a5e', '#f4bf4f', '#61c554'].map((c) => <span key={c} style={{ width: 9, height: 9, borderRadius: 9999, background: c }}/>)}</div>
        <H_Mono size={11} color="rgba(255,255,255,0.5)">mcp.json</H_Mono>
      </div>
      <pre style={{ margin: 0, padding: '16px 18px', background: '#111827', color: '#e5e7eb', fontSize: 12.5, fontFamily: H.mono, lineHeight: 1.7, whiteSpace: 'pre', overflowX: 'auto' }}>
{`{
  "mcpServers": {
    `}<span style={{ color: '#fcd34d' }}>{`"ultralight"`}</span>{`: {
      "url": `}<span style={{ color: '#a7f3d0' }}>{`"${H_MCP}"`}</span>{`,
      "headers": {
        "Authorization": "Bearer `}<span style={{ color: '#fcd34d' }}>{`$KEY`}</span>{`"
      }
    }
  }
}`}
      </pre>
    </div>
  );
}

function AgentChips() {
  return <window.LaunchChrome.LogoWall/>;
}

function HomeToolCard({ t }) {
  const free = t.free || (t.callPrice || 0) === 0;
  return (
    <div style={{ border: `1px solid ${H.border}`, borderRadius: 11, padding: 14, background: '#fff', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 120 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <H_Avatar name={t.author} color={t.authorColor} size={20}/>
        <span style={{ fontFamily: H.mono, fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
      </div>
      <div style={{ fontSize: 12, color: H.sec, lineHeight: 1.4, flex: 1 }}>{t.tagline}</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: `1px solid ${H.border}`, paddingTop: 8 }}>
        <H_Mono size={10.5} color={H.mute}>{hN(t.installs)} installs</H_Mono>
        {free && <span style={{ fontFamily: H.font, fontSize: 12, fontWeight: 600, color: H.greenDeep }}>Free</span>}
      </div>
    </div>
  );
}

// ── Value props — the core promise, editorial ───────────────────────────────
function ValueProps({ mobile }) {
  const items = [
    ['01', 'One core', 'Plug in and inherit your context, memory, tools, balance, and preferences. Welcome home.'],
    ['02', 'No subscriptions', 'Your agent pays per call — only for what it uses. Never a monthly seat.'],
    ['03', 'Open marketplace', 'Every published tool is discoverable and callable by any agent — no per-vendor setup.'],
    ['04', 'Inherited power', 'Every tool deployed inherits composability and distribution out the box.'],
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr' : 'repeat(4, 1fr)', gap: mobile ? 0 : 30 }}>
      {items.map(([n, t, d], i) => (
        <div key={n} style={{ paddingTop: mobile && i === 0 ? 0 : 15, borderTop: mobile && i === 0 ? 'none' : `1px solid ${H.text}`, marginTop: mobile && i > 0 ? 26 : 0 }}>
          <div style={{ fontFamily: H.font, fontSize: 13, fontWeight: 500, color: H.mute, marginBottom: mobile ? 8 : 18 }}>{n}</div>
          <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.015em', marginBottom: 7 }}>{t}</div>
          <div style={{ fontSize: 13.5, color: H.sec, lineHeight: 1.55 }}>{d}</div>
        </div>
      ))}
    </div>
  );
}

// ── Shared core — one layer, every agent ─────────────────────────────────
function SharedCore({ mobile }) {
  const layer = ['Context', 'Tools', 'Auth', 'Payments'];
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: mobile ? 13 : 22, flexWrap: 'wrap', justifyContent: 'center' }}>
      {layer.map((l, i) => (
        <React.Fragment key={l}>
          <span style={{ fontSize: mobile ? 16 : 20, color: H.text, letterSpacing: '-0.01em' }}>{l}</span>
          {i < layer.length - 1 && <span style={{ width: 4, height: 4, borderRadius: 9999, background: H.faint }}/>}
        </React.Fragment>
      ))}
    </div>
  );
}

function LoopStrip() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {LOOP.map((s, i) => (
        <React.Fragment key={i}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: H.sec, background: H.raised, border: `1px solid ${H.border}`, borderRadius: 8, padding: '8px 12px' }}><H_Mono size={11} color={H.mute}>{i + 1}</H_Mono>{s}</span>
          {i < LOOP.length - 1 && <span style={{ color: H.faint }}><H_Arr size={13}/></span>}
        </React.Fragment>
      ))}
    </div>
  );
}

function SectionHead({ k, title, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 16 }}>
      <div>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>{title}</div>
      </div>
      {action && <span style={{ fontSize: 13, fontWeight: 500, color: H.text, cursor: 'pointer' }}>{action} →</span>}
    </div>
  );
}

function HomeContent({ mobile, signedIn = false, balance = 0 }) {
  const hasLight = signedIn && balance > 0;
  const secondaryLabel = hasLight ? 'Deploy tool' : 'Developer docs';
  const O = window.LaunchHomeOrbit.OrbitalSystem;
  return (
    <div style={{ maxWidth: mobile ? '100%' : 880, margin: '0 auto', padding: mobile ? '40px 16px 48px' : '46px 32px 72px', fontFamily: H.font }}>
      {/* Hero */}
      <div style={{ display: mobile ? 'block' : 'grid', gridTemplateColumns: '1fr 1fr', gap: 28, alignItems: 'center', marginBottom: mobile ? 30 : 38 }}>
        <div>
          <div style={{ fontSize: mobile ? 30 : 46, fontWeight: 400, letterSpacing: '-0.035em', lineHeight: 1.05, marginBottom: 16 }}>Many agents?<br/>One tool layer.</div>
          <div style={{ fontSize: mobile ? 15 : 17, color: H.sec, lineHeight: 1.55, marginBottom: 24, width: mobile ? 'auto' : 520 }}>Connected agents now inherit every published tool,<br/>with unified auth and payments! Or deploy your own!</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <window.LaunchChrome.CopyAgentBtn size="lg"/>
            <H_Btn kind="secondary" size="lg">{secondaryLabel}</H_Btn>
          </div>
        </div>
        <div style={{ marginTop: mobile ? 28 : 0, overflow: 'visible', ...(mobile ? { height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center' } : { transform: 'translateX(-90px)' }) }}><O size={mobile ? 380 : 440}/></div>
      </div>

      {/* Value props — the core promise */}
      <div style={{ marginBottom: mobile ? 48 : 108 }}>
        <ValueProps mobile={mobile}/>
      </div>

      {/* Shared core — keep the “Thousands…” line */}
      <div style={{ marginBottom: mobile ? 48 : 80, textAlign: 'center', maxWidth: 640, marginLeft: 'auto', marginRight: 'auto' }}>
        <div style={{ fontSize: mobile ? 24 : 30, fontWeight: 400, letterSpacing: '-0.025em', lineHeight: 1.1, marginBottom: 12 }}>Thousands have given Ultralight to their agents</div>
        <div style={{ fontSize: mobile ? 15 : 16.5, color: H.sec, lineHeight: 1.55, marginBottom: 24 }}>Every agent draws from one core — the same context, tools, auth, and payments.</div>
        <SharedCore mobile={mobile}/>
      </div>

      {/* Featured tools */}
      <div style={{ marginBottom: mobile ? 48 : 80 }}>
        <SectionHead k="Store" title="Tools shipping now" action="Browse all"/>
        <div style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr' : 'repeat(3, 1fr)', gap: 12 }}>
          {H_TOOLS.slice(0, mobile ? 3 : 6).map((t) => <HomeToolCard key={t.id} t={t}/>)}
        </div>
      </div>

      {/* Connect — one endpoint */}
      <div style={{ display: mobile ? 'block' : 'grid', gridTemplateColumns: '0.92fr 1.08fr', gap: 36, alignItems: 'center', marginBottom: mobile ? 48 : 80 }}>
        <div style={{ marginBottom: mobile ? 22 : 0 }}>
          <div style={{ fontSize: mobile ? 24 : 30, fontWeight: 400, letterSpacing: '-0.025em', lineHeight: 1.1, marginBottom: 12 }}>One endpoint. Every capability.</div>
          <div style={{ fontSize: mobile ? 15 : 16.5, color: H.sec, lineHeight: 1.55, marginBottom: 18 }}>Point your agent at a single MCP server. It discovers the whole catalog, calls any tool, and settles in Light — no per-vendor keys or integrations.</div>
          <window.LaunchChrome.CopyAgentBtn size="lg"/>
        </div>
        <ConfigPreview/>
      </div>

      {/* Closing band */}
      <div style={{ borderRadius: 18, background: H.text, color: '#fff', padding: mobile ? '30px 24px' : '46px 44px', display: mobile ? 'block' : 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 28 }}>
        <div>
          <div style={{ fontSize: mobile ? 24 : 30, fontWeight: 400, letterSpacing: '-0.025em', lineHeight: 1.12, marginBottom: 8 }}>Give your agent the tool layer.</div>
          <div style={{ fontSize: mobile ? 14 : 15.5, color: 'rgba(255,255,255,0.6)', lineHeight: 1.5, maxWidth: 430 }}>One endpoint for every capability — discover, call, and settle in Light.</div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: mobile ? 22 : 0, flexShrink: 0 }}>
          <button onClick={(e) => window.LaunchChrome.showToast(e, 'Agent instruction copied. <span style="color:#9ca3af">Paste to your agent!</span>')} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: H.font, fontSize: 15.5, fontWeight: 500, color: H.text, background: '#fff', border: 'none', borderRadius: 10, padding: '11px 18px', cursor: 'pointer', whiteSpace: 'nowrap' }}><window.LaunchChrome.IconCopy size={15}/><span style={{ transform: 'translateY(0.5px)' }}>Add to agent</span></button>
          <button style={{ display: 'inline-flex', alignItems: 'center', fontFamily: H.font, fontSize: 15.5, fontWeight: 500, color: '#fff', background: 'transparent', border: '1px solid rgba(255,255,255,0.28)', borderRadius: 10, padding: '11px 18px', cursor: 'pointer', whiteSpace: 'nowrap' }}><span style={{ transform: 'translateY(0.5px)' }}>Browse the Store</span></button>
        </div>
      </div>
    </div>
  );
}

function HomeDesktop({ signedIn = false, balance = 0 }) {
  return (
    <H_Browser url="ultralight.dev" width={1280} height={1080}>
      <H_TopNav active="home" signedIn={signedIn} balance={balance}/>
      <H_Scroll><HomeContent signedIn={signedIn} balance={balance}/></H_Scroll>
    </H_Browser>
  );
}
function HomeMobile({ signedIn = false, balance = 0 }) {
  return (
    <H_Phone width={390} height={1000}>
      <H_Bar signedIn={signedIn} balance={balance}/>
      <H_Scroll><HomeContent mobile signedIn={signedIn} balance={balance}/></H_Scroll>
    </H_Phone>
  );
}

window.LaunchHome = { HomeDesktop, HomeMobile, HomeContent };
