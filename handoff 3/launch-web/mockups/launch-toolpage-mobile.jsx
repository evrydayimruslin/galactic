// launch-toolpage-mobile.jsx — Public tool page (mobile web) + states.

const { L: TPM, fmtN: tpmN } = window.LaunchData;
const TMC = window.LaunchChrome;
const {
  LAvatar: M_Avatar, LMono: M_Mono, LLabel: M_Label, LKindBadge: M_Kind, LTrustStamp: M_Trust,
  LCapPill: M_Cap, LBtn: M_Btn, LMobileBar: M_Bar, PhoneFrame: M_Phone, LScroll: M_Scroll,
  BrowserFrame: M_Browser, LTopNav: M_TopNav,
} = window.LaunchChrome;
const { WidgetPreview: M_Widget, TrustRail: M_Rail, ForecastCard: M_Forecast, WidgetSandboxFrame: M_Sandbox, Picker: M_Picker } = window.LaunchToolPage;

// ── Mobile widget section (clean, consumer-facing) ────────────────────────────
function MWidgets({ tool }) {
  const [sel, setSel] = React.useState(tool.widgets[0]?.id);
  const active = tool.widgets.find((w) => w.id === sel) || tool.widgets[0];
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 10 }}>
        <span style={{ fontSize: 13, color: TPM.sec }}>{tool.widgets.length} widgets</span>
        <M_Picker value={sel} onChange={setSel} size="sm" options={tool.widgets.map((w) => ({ id: w.id, label: w.label }))}/>
      </div>
      <M_Sandbox tool={tool} widget={active} state="ready"/>
    </div>
  );
}

// ── Mobile function row (tap expands a read-only example) ─────────────────────
function MFnRow({ tool, fn, open, onToggle }) {
  const reqs = { currency_convert: "{ from:'USD', to:'EUR', amount:100 }", get_weather: "{ city:'Tokyo', days:5 }" };
  const ress = { currency_convert: '{ "rate": 0.924, "result": 92.4 }', get_weather: '{ "tempC": 17, "hi": 24, "lo": 15 }' };
  return (
    <div style={{ borderBottom: `1px solid ${TPM.border}` }}>
      <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 2px', cursor: 'pointer' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: TPM.mono, fontSize: 12.5, fontWeight: 500 }}>{fn.name}</div>
          <div style={{ fontSize: 12, color: TPM.sec, marginTop: 2 }}>{fn.desc}</div>
        </div>
        <M_Mono size={11.5}>{fn.price > 0 ? `✦${fn.price.toFixed(3)}` : 'Free'}</M_Mono>
        <span style={{ display: 'inline-flex', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 160ms', color: TPM.mute }}><TMC.IconArrowRight size={13}/></span>
      </div>
      {open && (
        <div style={{ padding: '0 2px 12px', animation: 'pui-fade-up 200ms ease-out' }}>
          <div style={{ marginBottom: 6 }}><M_Mono size={10} color={TPM.mute}>example request</M_Mono></div>
          <pre style={{ margin: '0 0 8px', padding: 10, background: '#0a0a0a', color: '#e5e7eb', fontSize: 10.5, fontFamily: TPM.mono, lineHeight: 1.5, borderRadius: 8, whiteSpace: 'pre-wrap' }}>{`${fn.name}(${reqs[tool.slug] || '{ … }'})`}</pre>
          <div style={{ marginBottom: 6 }}><M_Mono size={10} color={TPM.mute}>example response</M_Mono></div>
          <pre style={{ margin: 0, padding: 10, background: '#0a0a0a', color: '#a7f3d0', fontSize: 10.5, fontFamily: TPM.mono, lineHeight: 1.5, borderRadius: 8, whiteSpace: 'pre-wrap' }}>{ress[tool.slug] || '{ "ok": true }'}</pre>
          <div style={{ marginTop: 8, fontSize: 11, color: TPM.mute }}>Calls run through MCP or the widget bridge — never in the browser.</div>
          <div style={{ marginTop: 12 }}><window.LaunchToolPage.PermissionControl fn={fn}/></div>
        </div>
      )}
    </div>
  );
}

function ToolPageMobile({ toolKey = 'weather', installed = false }) {
  const tool = toolKey === 'fx' ? window.LaunchData.TOOL_FX : window.LaunchData.TOOL_WEATHER;
  const builderRank = toolKey === 'fx' ? 3 : 1;
  const [open, setOpen] = React.useState(0);
  const hasWidgets = tool.widgets.length > 0;
  return (
    <M_Phone width={390} height={860}>
      <M_Bar signedIn={installed} cta={false}/>
      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <M_Scroll style={{ paddingBottom: 76 }}>
          <div style={{ padding: '16px 18px', fontFamily: TPM.font }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '4px 0 10px' }}>
              <M_Avatar name={tool.author} color={tool.authorColor} size={40}/>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 22, fontWeight: 500, letterSpacing: '-0.02em' }}>{tool.title || tool.name}</div>
                <div style={{ fontSize: 12, color: TPM.mute, marginTop: 3 }}>{(tool.author || '').replace('@', '')} · {tpmN(tool.installs)} installs</div>
              </div>
            </div>
            <div style={{ fontSize: 14.5, color: TPM.text, lineHeight: 1.5, marginBottom: 16 }}>{tool.tagline}</div>

            {hasWidgets && (
              <div style={{ marginBottom: 22 }}>
                <MWidgets tool={tool}/>
              </div>
            )}

            <div style={{ marginBottom: 22 }}>
              <M_Label mb={6}>Functions ({tool.functions.length})</M_Label>
              {tool.functions.map((f, i) => <MFnRow key={f.name} tool={tool} fn={f} open={open === i} onToggle={() => setOpen(open === i ? -1 : i)}/>)}
            </div>

            <M_Label mb={10}>Details</M_Label>
            <M_Rail tool={tool} builderRank={builderRank}/>
          </div>
        </M_Scroll>

        {/* Sticky install bar */}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '10px 16px', borderTop: `1px solid ${TPM.border}`, background: 'rgba(255,255,255,0.96)', backdropFilter: 'blur(8px)', display: 'flex', gap: 8 }}>
          <M_Btn kind={installed ? 'secondary' : 'primary'} size="lg" full>{installed ? <React.Fragment><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>Installed</React.Fragment> : 'Install'}</M_Btn>
          {!hasWidgets && <M_Btn kind="secondary" size="lg"><TMC.IconCopy size={15}/></M_Btn>}
        </div>
      </div>
    </M_Phone>
  );
}

// ── States ──────────────────────────────────────────────────────────────────
function StateFrame({ url, label, signedIn = false, children }) {
  return (
    <M_Browser url={url} width={840} height={560}>
      <M_TopNav active="store" signedIn={signedIn}/>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {children}
        {label && <div style={{ position: 'absolute', top: 12, left: 12, fontFamily: TPM.mono, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: TPM.mute, background: '#fff', border: `1px solid ${TPM.border}`, borderRadius: 5, padding: '3px 7px' }}>{label}</div>}
      </div>
    </M_Browser>
  );
}

function ToolLoading() {
  const Sk = ({ w, h = 10, mb = 8, r = 4 }) => <div style={{ width: w, height: h, borderRadius: r, background: '#eee', marginBottom: mb }}/>;
  return (
    <StateFrame url="ultralight.dev/tools/get_weather" label="Loading">
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '28px 32px' }}>
        <Sk w={180} h={9} mb={20}/>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 16 }}>
          <div style={{ width: 46, height: 46, borderRadius: 9999, background: '#eee' }}/>
          <div><Sk w={220} h={20} mb={8}/><Sk w={140} h={10} mb={0}/></div>
        </div>
        <Sk w="60%" h={14} mb={22}/>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 28 }}>
          <div>{Array.from({ length: 4 }).map((_, i) => <div key={i} style={{ borderBottom: `1px solid ${TPM.border}`, padding: '12px 0' }}><Sk w="45%" mb={6}/><Sk w="70%" h={8} mb={0}/></div>)}</div>
          <div style={{ border: `1px solid ${TPM.border}`, borderRadius: 12, padding: 14 }}>{Array.from({ length: 4 }).map((_, i) => <Sk key={i} w={i % 2 ? '60%' : '85%'} h={9}/>)}</div>
        </div>
      </div>
    </StateFrame>
  );
}

function ToolNotFound() {
  return (
    <StateFrame url="ultralight.dev/tools/get_weather" label="404 · removed or private">
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 40, textAlign: 'center' }}>
        <div style={{ width: 56, height: 56, borderRadius: 14, border: `1px solid ${TPM.border}`, display: 'grid', placeItems: 'center', color: TPM.mute }}><TMC.IconShield size={26}/></div>
        <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-0.01em' }}>This tool isn’t available</div>
        <div style={{ fontSize: 13.5, color: TPM.sec, maxWidth: 380, lineHeight: 1.55 }}>It may have been set to private, unpublished, or removed by its owner. Public and unlisted tools open here; private ones don’t.</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <M_Btn kind="primary">Browse the Store</M_Btn>
          <M_Btn kind="secondary">Go home</M_Btn>
        </div>
      </div>
    </StateFrame>
  );
}

window.LaunchToolPageMobile = { ToolPageMobile, ToolLoading, ToolNotFound, StateFrame };
