// launch-discover.jsx — Discover /discover (desktop + mobile) + states.
// Backend: GET /api/launch/discover → { results: LaunchToolSummary[], retrieval,
//   platformPrimitives } ; GET /api/launch/leaderboard?kind=builder|fee_credit.

const { L: D, fmtN: dN, fmtLight: dLight, DISCOVER_TOOLS, PRIMITIVES, LEADERBOARD_BUILDER, LEADERBOARD_FEE } = window.LaunchData;
const DC2 = window.LaunchChrome;
const {
  LAvatar: D_Avatar, LMono: D_Mono, LLabel: D_Label, LKindBadge: D_Kind, LSparkline: D_Spark,
  LBtn: D_Btn, LTopNav: D_TopNav, LMobileBar: D_Bar, BrowserFrame: D_Browser, PhoneFrame: D_Phone, LScroll: D_Scroll,
} = window.LaunchChrome;

const KINDS = [['all', 'All'], ['mcp', 'MCP'], ['http', 'HTTP'], ['markdown', 'Markdown']];

// ── Result card (dense) ────────────────────────────────────────────────────────
function ToolCard({ tool, onOpen }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div onClick={onOpen} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ cursor: 'pointer', border: `1px solid ${hover ? D.text : D.border}`, borderRadius: 10, padding: 14, background: '#fff', display: 'flex', flexDirection: 'column', gap: 9, minHeight: 124, transition: 'border-color 140ms ease' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <D_Avatar name={tool.author} color={tool.authorColor} size={22}/>
        <span style={{ fontFamily: D.mono, fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tool.name}</span>
      </div>
      <div style={{ fontSize: 12.5, color: D.sec, lineHeight: 1.45, flex: 1 }}>{tool.tagline}</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <D_Mono size={10.5} color={D.mute}>{dN(tool.installs)} installs</D_Mono>
        {tool.widgets > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontFamily: D.mono, color: D.sec }}><DC2.IconGrid size={11}/>{`${tool.widgets} widget${tool.widgets > 1 ? 's' : ''}`}</span>}
      </div>
    </div>
  );
}

// ── Retrieval banner (LaunchDiscoveryRetrievalSummary) ─────────────────────────
function RetrievalNote({ query }) {
  if (!query) return <div style={{ fontFamily: D.mono, fontSize: 11, color: D.mute, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Browsing all public tools · top by install</div>;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: D.mono, fontSize: 11, color: D.sec, flexWrap: 'wrap' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: D.greenDeep }}><span style={{ width: 6, height: 6, borderRadius: 9999, background: D.green }}/>hybrid retrieval</span>
      <span style={{ color: D.mute }}>4 semantic · 2 lexical · model text-embedding-3</span>
    </div>
  );
}

// ── Search bar (composer) ───────────────────────────────────────────────────────
function SearchControls({ query, onClear }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, border: `1px solid ${D.borderStrong}`, borderRadius: 10, padding: '10px 13px', background: '#fff' }}>
      <span style={{ color: D.mute, display: 'inline-flex' }}><window.PUI_Icons.IconSearch size={16}/></span>
      <span style={{ flex: 1, fontSize: 14, color: query ? D.text : D.mute, transform: 'translateY(0.5px)' }}>{query || 'Search tools, capabilities, widgets…'}</span>
      {query && <button onClick={onClear} style={{ border: 'none', background: 'transparent', color: D.mute, cursor: 'pointer', fontFamily: D.mono, fontSize: 14 }}>×</button>}
    </div>
  );
}

// ── Leaderboards ──────────────────────────────────────────────────────────────
function LeaderRow({ e, unit, first }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '16px 1fr auto', gap: 12, alignItems: 'center', padding: '9px 0', borderTop: first ? 'none' : `1px solid ${D.border}` }}>
      <span style={{ fontFamily: D.mono, fontSize: 11.5, fontWeight: 600, color: e.rank <= 3 ? D.text : D.mute, textAlign: 'left', fontVariantNumeric: 'tabular-nums' }}>{e.rank}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <D_Avatar name={e.name} color={e.color} size={20}/>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</div>
          {e.featured && <div style={{ fontSize: 10.5, fontFamily: D.mono, color: D.mute, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.featured}</div>}
        </div>
      </div>
      <D_Mono size={12} style={{ textAlign: 'right' }}>✦{dLight(e.value)}</D_Mono>
    </div>
  );
}
function LeaderBoard({ title, sub, data }) {
  const [period, setPeriod] = React.useState('30d');
  return (
    <div style={{ border: `1px solid ${D.border}`, borderRadius: 12, background: '#fff', overflow: 'hidden' }}>
      <div style={{ padding: '12px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</span>
          <div style={{ display: 'flex', gap: 2, background: D.hover, borderRadius: 7, padding: 2 }}>
            {['30d', '90d', 'all'].map((p) => (
              <button key={p} onClick={() => setPeriod(p)} style={{ fontFamily: D.mono, fontSize: 10.5, padding: '3px 7px', border: 'none', borderRadius: 5, cursor: 'pointer', background: period === p ? '#fff' : 'transparent', color: period === p ? D.text : D.mute, boxShadow: period === p ? '0 1px 2px rgba(0,0,0,0.06)' : 'none' }}>{p}</button>
            ))}
          </div>
        </div>
        <div style={{ fontSize: 11.5, color: D.mute, marginTop: 3 }}>{sub}</div>
      </div>
      <div style={{ padding: '2px 14px 8px' }}>{data.map((e, i) => <LeaderRow key={e.rank} e={e} first={i === 0}/>)}</div>
    </div>
  );
}

// ── Platform primitives rail ───────────────────────────────────────────────────
function PrimitivesRail() {
  return (
    <div style={{ border: `1px solid ${D.border}`, borderRadius: 12, background: '#fff', padding: '14px 16px' }}>
      <D_Label mb={10}>For agents · platform primitives</D_Label>
      <div>
        {PRIMITIVES.map((p, i) => (
          <div key={p.primitive} style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '10px 0', borderTop: i === 0 ? 'none' : `1px solid ${D.border}`, cursor: 'pointer' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }}>{p.label}</div>
              <div style={{ fontSize: 11.5, color: D.mute, marginTop: 2, lineHeight: 1.4 }}>{p.description}</div>
            </div>
            <D_Mono size={11} color={D.faint} style={{ whiteSpace: 'nowrap' }}>{p.route}</D_Mono>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Desktop ───────────────────────────────────────────────────────────────────
function DiscoverDesktop({ query = '', signedIn = false }) {
  return (
    <D_Browser url="ultralight.dev/discover" width={1280} height={900}>
      <D_TopNav active="store" signedIn={signedIn}/>
      <D_Scroll>
        <div style={{ maxWidth: 880, margin: '0 auto', padding: '51px 32px 56px', fontFamily: D.font }}>
          <div style={{ marginBottom: 22 }}>
            <div style={{ fontSize: 32, fontWeight: 400, letterSpacing: '-0.03em', lineHeight: 1.05, marginBottom: 18 }}>Tools your agent can call.</div>
            <SearchControls query={query}/>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 28, alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
                {DISCOVER_TOOLS.map((t) => <ToolCard key={t.id} tool={t}/>)}
              </div>
            </div>
            <aside style={{ display: 'flex', flexDirection: 'column', gap: 14, position: 'sticky', top: 16 }}>
              <PrimitivesRail/>
              <LeaderBoard title="Top builders" sub="By fees waived" data={LEADERBOARD_BUILDER}/>
              <LeaderBoard title="Fee credit" sub="Fee-waiver program" data={LEADERBOARD_FEE}/>
            </aside>
          </div>
        </div>
      </D_Scroll>
    </D_Browser>
  );
}

// ── Mobile ───────────────────────────────────────────────────────────────────
function DiscoverMobile({ query = '', tab = 'tools' }) {
  const [t, setT] = React.useState(tab);
  return (
    <D_Phone width={390} height={860}>
      <D_Bar/>
      <D_Scroll>
        <div style={{ padding: '16px 16px 40px', fontFamily: D.font }}>
          <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 14 }}>Store</div>
          <SearchControls query={query}/>
          <div style={{ display: 'flex', gap: 4, margin: '16px 0 12px', borderBottom: `1px solid ${D.border}` }}>
            {[['tools', 'Tools'], ['builders', 'Builders'], ['fees', 'Fee credit']].map(([id, label]) => (
              <button key={id} onClick={() => setT(id)} style={{ fontSize: 13, fontWeight: t === id ? 600 : 500, color: t === id ? D.text : D.mute, padding: '7px 9px', border: 'none', borderBottom: `2px solid ${t === id ? D.text : 'transparent'}`, background: 'transparent', cursor: 'pointer', marginBottom: -1, fontFamily: 'inherit' }}>{label}</button>
            ))}
          </div>
          {t === 'tools' && (
            <React.Fragment>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{DISCOVER_TOOLS.map((tl) => <ToolCard key={tl.id} tool={tl}/>)}</div>
            </React.Fragment>
          )}
          {t === 'builders' && <div style={{ border: `1px solid ${D.border}`, borderRadius: 12, padding: '4px 14px 10px' }}>{LEADERBOARD_BUILDER.map((e) => <LeaderRow key={e.rank} e={e}/>)}</div>}
          {t === 'fees' && <div style={{ border: `1px solid ${D.border}`, borderRadius: 12, padding: '4px 14px 10px' }}>{LEADERBOARD_FEE.map((e) => <LeaderRow key={e.rank} e={e}/>)}</div>}
        </div>
      </D_Scroll>
    </D_Phone>
  );
}

// ── Empty / no-results state ───────────────────────────────────────────────────
function DiscoverEmpty() {
  const { StateFrame } = window.LaunchToolPageMobile;
  return (
    <StateFrame url="ultralight.dev/discover?q=quantum+fax" label="No results · semantic → lexical fallback">
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '26px 32px' }}>
        <SearchControls query="quantum fax machine driver"/>
        <div style={{ marginTop: 22, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '40px 20px', border: `1px dashed ${D.borderStrong}`, borderRadius: 12, background: D.raised, textAlign: 'center' }}>
          <span style={{ color: D.mute }}><window.PUI_Icons.IconSearch size={28}/></span>
          <div style={{ fontSize: 16, fontWeight: 600 }}>No tools match that yet</div>
          <div style={{ fontSize: 12.5, color: D.sec, maxWidth: 380, lineHeight: 1.55 }}>Semantic search returned nothing above threshold, so we fell back to lexical — still empty. Try broader terms, or browse by kind.</div>
          <div style={{ fontFamily: D.mono, fontSize: 10.5, color: D.mute }}>retrieval: semantic ✗ → lexical ✗ · fallbackReason: "no launch-safe rows"</div>
          <D_Btn kind="primary" style={{ marginTop: 4 }}>Clear search</D_Btn>
        </div>
      </div>
    </StateFrame>
  );
}

// ── Frameless backdrops (reused behind the sign-in scrim) ─────────────────────
function DiscoverBackdrop() {
  return (
    <div style={{ maxWidth: 880, margin: '0 auto', padding: '51px 32px 56px', fontFamily: D.font }}>
      <div style={{ marginBottom: 22 }}>
        <div style={{ fontSize: 32, fontWeight: 400, letterSpacing: '-0.03em', lineHeight: 1.05, marginBottom: 18 }}>Tools your agent can call.</div>
        <SearchControls query=""/>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 28, alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
            {DISCOVER_TOOLS.map((t) => <ToolCard key={t.id} tool={t}/>)}
          </div>
        </div>
        <aside style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <PrimitivesRail/>
          <LeaderBoard title="Top builders" sub="By fees waived" data={LEADERBOARD_BUILDER}/>
        </aside>
      </div>
    </div>
  );
}
function DiscoverBackdropMobile() {
  return (
    <div style={{ padding: '16px 16px 40px', fontFamily: D.font }}>
      <div style={{ fontSize: 24, fontWeight: 400, letterSpacing: '-0.02em', marginBottom: 14 }}>Tools your agent can call.</div>
      <SearchControls query=""/>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>{DISCOVER_TOOLS.slice(0, 4).map((tl) => <ToolCard key={tl.id} tool={tl}/>)}</div>
    </div>
  );
}

window.LaunchDiscover = { DiscoverDesktop, DiscoverMobile, DiscoverEmpty, DiscoverBackdrop, DiscoverBackdropMobile, ToolCard };
