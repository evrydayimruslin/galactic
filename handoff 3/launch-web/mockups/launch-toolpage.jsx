// launch-toolpage.jsx — Public tool page /tools/:slug (desktop) + shared atoms.
// No auth needed to view. Two shapes per LAUNCH_MVP_SCOPE:
//   • widget tool  → widget preview is the primary surface (get_weather)
//   • no widgets   → install + functions + capabilities + trust (currency_convert)
// Backend: GET /api/launch/tools/:id → { tool: LaunchToolSummary, trustCard },
//          GET /api/launch/tools/:id/widgets → LaunchWidgetSummary[].

const { L: TP, fmtN: tpFmtN, fmtLight: tpFmtLight } = window.LaunchData;
const TC = window.LaunchChrome;
const {
  LAvatar: T_Avatar, LMono: T_Mono, LLabel: T_Label, LKindBadge: T_Kind, LTrustStamp: T_Trust,
  LCapPill: T_Cap, LBtn: T_Btn, LTopNav: T_TopNav, LMobileBar: T_MobileBar,
  BrowserFrame: T_Browser, PhoneFrame: T_Phone, LScroll: T_Scroll,
  IconExternal: T_Ext, IconCopy: T_Copy, IconShield: T_Shield,
} = window.LaunchChrome;

// ── Install button (toggles installed; post-auth state) ───────────────────────
function InstallButton({ tool, installed: ext, size = 'lg', full }) {
  const [on, setOn] = React.useState(!!ext);
  const toggle = (e) => {
    const ct = e.currentTarget;
    if (!on) window.LaunchChrome.showToast({ currentTarget: ct }, `“${tool.title || tool.name}” was added to your library.`);
    setOn((v) => !v);
  };
  return (
    <T_Btn kind={on ? 'secondary' : 'primary'} size={size} full={full} onClick={toggle} style={{ padding: size === 'lg' ? '8px 22px' : undefined }}>
      {on ? <React.Fragment><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>Installed</React.Fragment> : 'Install'}
    </T_Btn>
  );
}

// ── Custom dropdown picker (house design language, replaces native <select>) ───
function Picker({ value, options, onChange, minWidth = 180, size = 'md' }) {
  const [open, setOpen] = React.useState(false);
  const cur = options.find((o) => o.id === value) || options[0];
  const fs = size === 'sm' ? 13.5 : 14;
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button onClick={() => setOpen((o) => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontFamily: TP.font, fontSize: fs, fontWeight: 600, color: TP.text, padding: size === 'sm' ? '7px 11px' : '8px 13px', border: `1px solid ${open ? TP.text : TP.borderStrong}`, borderRadius: 9, background: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' }}>
        <span style={{ transform: 'translateY(0.5px)' }}>{cur.label}</span>
        <span style={{ color: TP.mute, fontSize: 10, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 140ms' }}>▾</span>
      </button>
      {open && (
        <React.Fragment>
          <span onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }}/>
          <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, minWidth, zIndex: 41, background: '#fff', border: `1px solid ${TP.border}`, borderRadius: 12, boxShadow: '0 14px 38px rgba(0,0,0,0.14)', padding: 5 }}>
            {options.map((o) => (
              <button key={o.id} onClick={() => { onChange(o.id); setOpen(false); }} style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 9, fontFamily: TP.font, fontSize: 13.5, fontWeight: o.id === value ? 600 : 500, color: TP.text, padding: '8px 10px', border: 'none', borderRadius: 8, background: o.id === value ? TP.raised : 'transparent', cursor: 'pointer' }}>
                <span style={{ width: 13, display: 'inline-flex', justifyContent: 'center', color: TP.text }}>{o.id === value ? '✓' : ''}</span>
                <span>{o.label}{o.hint && <span style={{ color: TP.mute, fontWeight: 400 }}> {o.hint}</span>}</span>
              </button>
            ))}
          </div>
        </React.Fragment>
      )}
    </span>
  );
}

// ── Try-it sandbox (compact) ───────────────────────────────────────────────────
function Sandbox({ tool, fn }) {
  const reqs = { currency_convert: { from: 'USD', to: 'EUR', amount: 100 }, get_weather: { city: 'Tokyo', days: 5 } };
  const ress = { currency_convert: { rate: 0.924, result: 92.4, asOf: '2026-06-02T14:00Z' }, get_weather: { tempC: 17, conditions: 'partly cloudy', hi: 24, lo: 15 } };
  const req = reqs[tool.slug] || { city: 'Tokyo' };
  const res = ress[tool.slug] || { ok: true };
  return (
    <div style={{ border: `1px solid ${TP.border}`, background: '#fff', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
        <div style={{ padding: 13, borderRight: `1px solid ${TP.border}` }}>
          <T_Label mb={8}>example request</T_Label>
          <pre style={{ margin: 0, padding: 10, background: '#0a0a0a', color: '#e5e7eb', fontSize: 10.5, fontFamily: TP.mono, lineHeight: 1.5, borderRadius: 6, whiteSpace: 'pre-wrap' }}>{`${fn.name}(${JSON.stringify(req, null, 2)})`}</pre>
        </div>
        <div style={{ padding: 13, minWidth: 0 }}>
          <T_Label mb={8}>example response</T_Label>
          <pre style={{ margin: 0, padding: 10, background: '#0a0a0a', color: '#a7f3d0', fontSize: 10.5, fontFamily: TP.mono, lineHeight: 1.5, borderRadius: 6, whiteSpace: 'pre-wrap' }}>{JSON.stringify(res, null, 2)}</pre>
        </div>
      </div>
      <div style={{ padding: '8px 13px', borderTop: `1px solid ${TP.border}`, background: TP.raised, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontSize: 11, color: TP.mute }}>Calls run through MCP or the widget bridge — never in the browser.</span>
        <T_Mono size={11}>{fn.price > 0 ? `✦${fn.price.toFixed(3)} / call` : 'free'}</T_Mono>
      </div>
    </div>
  );
}

// ── Function table ─────────────────────────────────────────────────────────────
function FnRow({ tool, fn, last, open, onToggle }) {
  return (
    <div style={{ borderBottom: last ? 'none' : `1px solid ${TP.border}` }}>
      <div onClick={onToggle} style={{ display: 'grid', gridTemplateColumns: '1fr 96px 64px 20px', alignItems: 'center', gap: 14, padding: '11px 4px', cursor: 'pointer' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: TP.mono, fontSize: 13, fontWeight: 500 }}>{fn.name}<span style={{ color: TP.mute, fontWeight: 400 }}>{fn.args}</span></div>
          <div style={{ fontSize: 12, color: TP.sec, marginTop: 2 }}>{fn.desc}</div>
        </div>
        <T_Mono size={12} style={{ textAlign: 'right' }}>{fn.price > 0 ? <React.Fragment>✦{fn.price.toFixed(3)}<span style={{ color: TP.mute }}>/call</span></React.Fragment> : <span style={{ color: TP.sec }}>Free</span>}</T_Mono>
        <T_Mono size={11} color={TP.mute} style={{ textAlign: 'center' }}>{fn.p50}ms</T_Mono>
        <span style={{ display: 'inline-flex', justifyContent: 'flex-end', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 160ms ease', color: TP.mute }}><TC.IconArrowRight size={13}/></span>
      </div>
      {open && <div style={{ padding: '2px 4px 14px', animation: 'pui-fade-up 200ms ease-out' }}><Sandbox tool={tool} fn={fn}/></div>}
    </div>
  );
}
function FnTable({ tool }) {
  const [open, setOpen] = React.useState(0);
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 96px 64px 20px', gap: 14, padding: '0 4px 8px', borderBottom: `1px solid ${TP.border}`, fontFamily: TP.mono, fontSize: 10.5, color: TP.mute, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        <span>Function ({tool.functions.length})</span><span style={{ textAlign: 'right' }}>Price</span><span style={{ textAlign: 'center' }}>p50</span><span/>
      </div>
      {tool.functions.map((f, i) => <FnRow key={f.name} tool={tool} fn={f} last={i === tool.functions.length - 1} open={open === i} onToggle={() => setOpen(open === i ? -1 : i)}/>)}
    </div>
  );
}

// ── Widget preview (the primary public surface for widget tools) ──────────────
function ForecastCard() {
  const days = [['Mon', 24, 17], ['Tue', 23, 16], ['Wed', 21, 15], ['Thu', 22, 16], ['Fri', 25, 18]];
  return (
    <div style={{ width: '100%', maxWidth: 320, border: `1px solid ${TP.border}`, borderRadius: 12, background: '#fff', padding: 16, boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Tokyo</span>
        <T_Mono size={11} color={TP.mute}>partly cloudy</T_Mono>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: 40, fontWeight: 700, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>17°</span>
        <span style={{ fontSize: 12, color: TP.sec }}>H:24° L:15°</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 4 }}>
        {days.map(([d, hi, lo]) => (
          <div key={d} style={{ textAlign: 'center', padding: '8px 0', borderRadius: 8, background: TP.raised }}>
            <div style={{ fontSize: 10, color: TP.mute, fontFamily: TP.mono }}>{d}</div>
            <div style={{ width: 14, height: 14, borderRadius: 9999, background: '#dbeafe', margin: '6px auto' }}/>
            <T_Mono size={11}>{hi}°</T_Mono>
          </div>
        ))}
      </div>
    </div>
  );
}
function NowBadge() {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, border: `1px solid ${TP.border}`, borderRadius: 9999, background: '#fff', padding: '9px 16px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
      <span style={{ width: 18, height: 18, borderRadius: 9999, background: '#dbeafe' }}/>
      <span style={{ fontSize: 13, fontWeight: 600 }}>Tokyo 17°</span>
      <T_Mono size={11} color={TP.mute}>partly cloudy</T_Mono>
    </div>
  );
}
function WidgetPreview({ tool }) {
  const [sel, setSel] = React.useState(tool.widgets[0]?.id);
  const active = tool.widgets.find((w) => w.id === sel) || tool.widgets[0];
  return (
    <div style={{ border: `1px solid ${TP.borderStrong}`, borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 14px', borderBottom: `1px solid ${TP.border}`, background: TP.raised }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {tool.widgets.map((w) => (
            <button key={w.id} onClick={() => setSel(w.id)} style={{ fontFamily: TP.mono, fontSize: 11.5, fontWeight: 500, padding: '5px 10px', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap', border: `1px solid ${sel === w.id ? TP.text : TP.border}`, background: sel === w.id ? TP.text : '#fff', color: sel === w.id ? '#fff' : TP.sec }}>{w.label}</button>
          ))}
        </div>
        <T_Btn kind="secondary" size="sm"><TC.IconExternal size={13}/>Open widget</T_Btn>
      </div>
      <div style={{ minHeight: 220, display: 'grid', placeItems: 'center', padding: 28, background: 'repeating-linear-gradient(45deg, #fcfcfc, #fcfcfc 10px, #fafafa 10px, #fafafa 20px)' }}>
        {active?.id === 'now_badge' ? <NowBadge/> : <ForecastCard/>}
      </div>
      <div style={{ padding: '9px 14px', borderTop: `1px solid ${TP.border}`, fontSize: 11.5, color: TP.mute }}>
        {active?.description} · <T_Mono size={11} color={TP.mute}>public · embeddable</T_Mono>
      </div>
    </div>
  );
}

// ── Trust + pricing + owner side rail ──────────────────────────────────────────
function RailCard({ title, children, foot }) {
  return (
    <div style={{ border: `1px solid ${TP.border}`, borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
      <div style={{ padding: '12px 14px', borderBottom: foot === false ? 'none' : `1px solid ${TP.border}` }}>
        <T_Label mb={10}>{title}</T_Label>
        {children}
      </div>
      {foot}
    </div>
  );
}
function MetaRow({ k, v }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, padding: '4px 0', fontSize: 12.5 }}><span style={{ color: TP.sec, whiteSpace: 'nowrap' }}>{k}</span><T_Mono size={12} style={{ whiteSpace: 'nowrap' }}>{v}</T_Mono></div>;
}
function TrustRail({ tool, builderRank }) {
  const paid = tool.functions.filter((f) => f.price > 0).length;
  const minPrice = Math.min(...tool.functions.filter((f) => f.price > 0).map((f) => f.price));
  const trustData = { title: tool.name, signed: true, version: tool.version, runtime: 'deno · edge', receipts: true, perms: tool.capabilities, setup: [], owner: false, visibility: tool.visibility };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <window.LaunchTrust.TrustSetupCard variant="ready" data={trustData}/>
      <RailCard title="Pricing" foot={false}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: TP.greenDeep, whiteSpace: 'nowrap' }}>Free to install</span>
        </div>
        <MetaRow k="Metering" v="per call"/>
        <MetaRow k="Paid functions" v={`${paid} of ${tool.functions.length}`}/>
        {Number.isFinite(minPrice) && <MetaRow k="From" v={`✦${minPrice.toFixed(3)}`}/>}
      </RailCard>
      <RailCard title="Owner"
        foot={<div style={{ padding: '10px 14px', borderTop: `1px solid ${TP.border}`, background: TP.raised, fontSize: 12, color: TP.sec }}>Builder rank <T_Mono size={12} color={TP.text}>#{builderRank}</T_Mono> · 30d earnings</div>}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <T_Avatar name={tool.author} color={tool.authorColor} size={32}/>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{tool.author}</div>
            <div style={{ fontSize: 11.5, color: TP.mute }}>View builder profile →</div>
          </div>
        </div>
      </RailCard>
      <div>
        <T_Label mb={8}>Works with</T_Label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {['Claude Code', 'Cursor', 'Codex', 'MCP', 'CLI', 'API'].map((t) => (
            <span key={t} style={{ fontSize: 11, fontFamily: TP.mono, color: TP.sec, border: `1px solid ${TP.border}`, borderRadius: 6, padding: '3px 7px' }}>{t}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Functions tab: argument sandbox ──────────────────────────────────────────
function parseArgs(argStr) {
  const inner = (argStr || '').replace(/[{}]/g, '').trim();
  return inner ? inner.split(',').map((s) => s.trim()).filter(Boolean) : [];
}
const ARG_DEFAULTS = { city: 'Tokyo', days: '5', date: '2026-05-01', from: 'USD', to: 'EUR', amount: '100' };
const ARG_HINT = { city: 'city name', days: '1–14', date: 'YYYY-MM-DD', from: 'ISO 4217', to: 'ISO 4217', amount: 'number' };
function fnResponse(slug, name) {
  const M = {
    'get_weather.forecast': { city: 'Tokyo', unit: 'C', days: 5, forecast: [{ day: 'Mon', hi: 24, lo: 17, sky: 'cloudy' }, { day: 'Tue', hi: 23, lo: 16, sky: 'rain' }] },
    'get_weather.now': { city: 'Tokyo', tempC: 17, conditions: 'partly cloudy', hi: 24, lo: 15 },
    'get_weather.alerts': { city: 'Tokyo', active: false, alerts: [] },
    'get_weather.historical': { city: 'Tokyo', date: '2026-05-01', tempC: 19, conditions: 'clear' },
    'currency_convert.convert': { from: 'USD', to: 'EUR', amount: 100, rate: 0.924, result: 92.40, asOf: '2026-06-02T14:00Z' },
    'currency_convert.historical': { from: 'USD', to: 'EUR', date: '2026-05-01', rate: 0.918 },
    'currency_convert.list_pairs': { count: 182, sample: ['USD/EUR', 'USD/JPY', 'GBP/USD', 'EUR/JPY'] },
  };
  return M[`${slug}.${name}`] || { ok: true };
}
function FunctionSandbox({ tool, fn }) {
  const args = parseArgs(fn.args);
  const [ran, setRan] = React.useState(false);
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ border: `1px solid ${TP.border}`, borderRadius: 12, background: '#fff', overflow: 'hidden' }}>
        <div style={{ padding: '13px 16px', borderBottom: `1px solid ${TP.border}`, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 14 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: TP.mono, fontSize: 14, fontWeight: 600 }}>{fn.name}</div>
            <div style={{ fontSize: 12.5, color: TP.sec, marginTop: 3 }}>{fn.desc}</div>
          </div>
          <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
            <T_Mono size={12}>{fn.price > 0 ? `✦${fn.price.toFixed(3)}/call` : 'Free'}</T_Mono>
          </div>
        </div>
        <div style={{ padding: 16 }}>
          {args.length > 0 ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
              {args.map((a) => (
                <label key={a} style={{ display: 'block' }}>
                  <div style={{ fontFamily: TP.mono, fontSize: 11, color: TP.sec, marginBottom: 4 }}>{a}<span style={{ color: TP.mute }}> · {ARG_HINT[a] || 'value'}</span></div>
                  <input defaultValue={ARG_DEFAULTS[a] || ''} placeholder={ARG_HINT[a] || 'value'} style={{ width: '100%', boxSizing: 'border-box', fontFamily: TP.mono, fontSize: 12.5, padding: '8px 10px', border: `1px solid ${TP.border}`, borderRadius: 8, background: TP.raised, color: TP.text, outline: 'none' }}/>
                </label>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: TP.mute, fontFamily: TP.mono }}>No arguments.</div>
          )}
          <div style={{ marginTop: 16 }}>
            <T_Btn kind="primary" size="sm" onClick={() => setRan(true)}><TC.IconArrowRight size={13}/>Run</T_Btn>
            <div style={{ fontSize: 11, color: TP.mute, marginTop: 12 }}>Runs in a sandbox — billed to your wallet at the per-call rate.</div>
          </div>
          {ran && (
            <div style={{ animation: 'pui-fade-up 200ms ease-out', marginTop: 14 }}>
              <T_Label mb={6}>response · 200</T_Label>
              <pre style={{ margin: 0, padding: 12, background: '#0a0a0a', color: '#a7f3d0', fontSize: 11, fontFamily: TP.mono, lineHeight: 1.55, borderRadius: 8, whiteSpace: 'pre-wrap' }}>{JSON.stringify(fnResponse(tool.slug, fn.name), null, 2)}</pre>
            </div>
          )}
        </div>
      </div>
      <div style={{ marginTop: 14, border: `1px solid ${TP.border}`, borderRadius: 12, background: '#fff', padding: '13px 16px' }}><PermissionControl fn={fn}/></div>
    </div>
  );
}

// Per-function agent permission: Always / Always ask / Never, with Save.
const PERM_OPTIONS = [['always', 'Always'], ['ask', 'Always ask'], ['never', 'Never']];
function PermissionControl({ fn }) {
  const [perm, setPerm] = React.useState(fn.perm || 'ask');
  const [savedPerm, setSavedPerm] = React.useState(fn.perm || 'ask');
  const dirty = perm !== savedPerm;
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 12.5, color: TP.sec, fontWeight: 500, whiteSpace: 'nowrap' }}>Agent permission</span>
        <div style={{ display: 'inline-flex', gap: 2, padding: 2, border: `1px solid ${TP.border}`, borderRadius: 9, background: TP.raised }}>
          {PERM_OPTIONS.map(([id, label]) => (
            <button key={id} onClick={() => setPerm(id)} style={{ fontFamily: TP.font, fontSize: 12, fontWeight: perm === id ? 600 : 500, padding: '5px 11px', borderRadius: 7, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap', background: perm === id ? '#fff' : 'transparent', color: perm === id ? TP.text : TP.sec, boxShadow: perm === id ? '0 1px 2px rgba(0,0,0,0.06)' : 'none' }}>{label}</button>
          ))}
        </div>
      </div>
      <T_Btn kind={dirty ? 'primary' : 'secondary'} size="sm" onClick={() => setSavedPerm(perm)}>{dirty ? 'Save' : 'Saved'}</T_Btn>
    </div>
  );
}
function FunctionsTab({ tool, sel }) {
  const fn = tool.functions.find((f) => f.name === sel) || tool.functions[0];
  return (
    <div>
      <FunctionSandbox tool={tool} fn={fn}/>
    </div>
  );
}

// A tab label that doubles as a selector (▾ dropdown) — used by Functions & Widgets.
function TabDropdown({ label, active, options, sel, onSelect, onActivate, mono = false, minWidth = 240 }) {
  const [open, setOpen] = React.useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <span onClick={() => { if (!active) { onActivate(); setOpen(true); } else { setOpen((o) => !o); } }}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: active ? 600 : 500, color: active ? TP.text : TP.mute, padding: '9px 11px', borderBottom: `2px solid ${active ? TP.text : 'transparent'}`, marginBottom: -1, cursor: 'pointer', whiteSpace: 'nowrap' }}>
        {label}
        <span style={{ fontSize: 9, color: active ? TP.sec : TP.mute, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 140ms' }}>▾</span>
      </span>
      {open && active && (
        <React.Fragment>
          <span onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }}/>
          <div style={{ position: 'absolute', top: 'calc(100% + 8px)', left: 0, minWidth, zIndex: 41, background: '#fff', border: `1px solid ${TP.border}`, borderRadius: 12, boxShadow: '0 14px 38px rgba(0,0,0,0.14)', padding: 5 }}>
            {options.map((o) => (
              <button key={o.id} onClick={() => { onSelect(o.id); setOpen(false); }} style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 9, fontFamily: TP.font, fontSize: 13.5, fontWeight: o.id === sel ? 600 : 500, color: TP.text, padding: '8px 10px', border: 'none', borderRadius: 8, background: o.id === sel ? TP.raised : 'transparent', cursor: 'pointer' }}>
                <span style={{ width: 13, display: 'inline-flex', justifyContent: 'center', color: TP.text }}>{o.id === sel ? '✓' : ''}</span>
                <span style={{ minWidth: 0, flex: 1 }}><span style={{ fontFamily: mono ? TP.mono : TP.font }}>{o.label}</span>{o.desc && <span style={{ display: 'block', fontFamily: TP.font, fontWeight: 400, fontSize: 11.5, color: TP.mute, marginTop: 1 }}>{o.desc}</span>}</span>
              </button>
            ))}
          </div>
        </React.Fragment>
      )}
    </span>
  );
}

// ── Widgets tab: first-class surface, dropdown + scroll ───────────────────────
// Renders the developer-authored widget HTML inside the sandboxed iframe frame
// (relay footer, "no key" guarantees) right here as the default tool surface.
function WidgetSpinner({ size = 22 }) {
  return <span style={{ width: size, height: size, border: `2px solid ${TP.border}`, borderTopColor: TP.text, borderRadius: 9999, display: 'inline-block', animation: 'pui-spin 0.7s linear infinite' }}/>;
}
function WidgetSandboxBody({ tool, widget, state }) {
  if (state === 'loading') return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <WidgetSpinner size={24}/>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Starting widget session…</div>
    </div>
  );
  if (state === 'error') return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center', maxWidth: 380 }}>
      <span style={{ width: 44, height: 44, borderRadius: 11, background: 'rgba(239,68,68,0.09)', display: 'grid', placeItems: 'center', color: '#ef4444' }}><T_Shield size={20}/></span>
      <div style={{ fontSize: 16, fontWeight: 600 }}>Couldn’t load this widget</div>
      <div style={{ fontSize: 12.5, color: TP.sec, lineHeight: 1.5 }}>The widget UI function failed to render. Your balance wasn’t charged.</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 2 }}><T_Btn kind="primary" size="sm">Retry</T_Btn><T_Btn kind="secondary" size="sm">Report</T_Btn></div>
    </div>
  );
  if (state === 'setup') return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center', maxWidth: 400 }}>
      <span style={{ width: 44, height: 44, borderRadius: 11, background: TP.amberSoft, display: 'grid', placeItems: 'center', color: TP.amberDeep }}><T_Shield size={20}/></span>
      <div style={{ fontSize: 16, fontWeight: 600 }}>Finish setup to run this widget</div>
      <div style={{ fontSize: 12.5, color: TP.sec, lineHeight: 1.55 }}>{tool.slug} needs a connection and one secret before this widget can run. You’ll be routed to your settings — your API key is never shared with the widget.</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 2 }}><T_Btn kind="primary" size="sm">Go to setup</T_Btn><T_Btn kind="ghost" size="sm">Why is this needed?</T_Btn></div>
    </div>
  );
  // ready
  const isBadge = widget?.id === 'now_badge';
  if (isBadge) return <NowBadge/>;
  return (
    <div style={{ width: '100%', maxWidth: 340, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${TP.border}`, borderRadius: 9, padding: '8px 11px', background: '#fff' }}>
          <span style={{ color: TP.mute, display: 'inline-flex' }}><window.PUI_Icons.IconSearch size={14}/></span>
          <span style={{ fontSize: 13, color: TP.text }}>Tokyo</span>
        </div>
        <button style={{ width: 38, borderRadius: 9, border: `1px solid ${TP.border}`, background: '#fff', cursor: 'pointer', color: TP.sec }}>↻</button>
      </div>
      <ForecastCard/>
    </div>
  );
}
function WidgetSandboxFrame({ tool, widget, state = 'ready' }) {
  return (
    <div>
      <div style={{ position: 'relative', minHeight: 340, display: 'grid', placeItems: 'center', padding: '20px 0 8px' }}>
        <WidgetSandboxBody tool={tool} widget={widget} state={state}/>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 12 }}>
        <span style={{ color: TP.mute, display: 'inline-flex' }}><T_Shield size={13}/></span>
        <span style={{ fontSize: 12, color: TP.mute }}>Calls relay through Ultralight — the widget never sees your API key.</span>
      </div>
    </div>
  );
}
const WIDGET_STATES = [['ready', 'Ready'], ['loading', 'Loading'], ['error', 'Error'], ['setup', 'Setup required']];
function WidgetsTab({ tool, sel }) {
  const [state, setState] = React.useState('ready');
  const active = tool.widgets.find((w) => w.id === sel) || tool.widgets[0];
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <T_Mono size={10.5} color={TP.mute} style={{ letterSpacing: '0.05em', textTransform: 'uppercase' }}>State</T_Mono>
        <div style={{ display: 'inline-flex', gap: 2, padding: 2, border: `1px solid ${TP.border}`, borderRadius: 9, background: TP.raised }}>
          {WIDGET_STATES.map(([id, label]) => (
            <button key={id} onClick={() => setState(id)} style={{ fontFamily: TP.font, fontSize: 12, fontWeight: state === id ? 600 : 500, padding: '5px 11px', borderRadius: 7, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap', background: state === id ? '#fff' : 'transparent', color: state === id ? TP.text : TP.sec, boxShadow: state === id ? '0 1px 2px rgba(0,0,0,0.06)' : 'none' }}>{label}</button>
          ))}
        </div>
      </div>
      <WidgetSandboxFrame tool={tool} widget={active} state={state}/>
    </div>
  );
}

// ── Trust tab: trust card + pricing + owner + works-with ──────────────────────
function TrustTab({ tool, builderRank }) {
  const paid = tool.functions.filter((f) => f.price > 0).length;
  const minPrice = Math.min(...tool.functions.filter((f) => f.price > 0).map((f) => f.price));
  const trustData = { title: tool.name, signed: true, version: tool.version, runtime: 'deno · edge', receipts: true, perms: tool.capabilities, setup: [], owner: false, visibility: tool.visibility };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 20, alignItems: 'flex-start' }}>
      <window.LaunchTrust.TrustSetupCard variant="ready" data={trustData}/>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <RailCard title="Pricing" foot={false}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: TP.greenDeep, whiteSpace: 'nowrap' }}>Free to install</span>
          </div>
          <MetaRow k="Metering" v="per call"/>
          <MetaRow k="Paid functions" v={`${paid} of ${tool.functions.length}`}/>
          {Number.isFinite(minPrice) && <MetaRow k="From" v={`✦${minPrice.toFixed(3)}`}/>}
          <MetaRow k="Calls / day" v={tpFmtN(tool.callsPerDay)}/>
        </RailCard>
        <RailCard title="Owner"
          foot={<div style={{ padding: '10px 14px', borderTop: `1px solid ${TP.border}`, background: TP.raised, fontSize: 12, color: TP.sec }}>Builder rank <T_Mono size={12} color={TP.text}>#{builderRank}</T_Mono> · 30d earnings</div>}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <T_Avatar name={tool.author} color={tool.authorColor} size={32}/>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{tool.author}</div>
              <div style={{ fontSize: 11.5, color: TP.mute }}>View builder profile →</div>
            </div>
          </div>
        </RailCard>
        <div>
          <T_Label mb={8}>Works with</T_Label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {['Claude Code', 'Cursor', 'Codex', 'MCP', 'CLI', 'API'].map((t) => (
              <span key={t} style={{ fontSize: 11, fontFamily: TP.mono, color: TP.sec, border: `1px solid ${TP.border}`, borderRadius: 6, padding: '3px 7px' }}>{t}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Header (shared) ─────────────────────────────────────────────────────────────
function ToolHeader({ tool, installed, unlisted }) {
  return (
    <div style={{ marginBottom: 28, maxWidth: 720 }}>
      {unlisted && (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginTop: 12, marginBottom: 2, padding: '6px 11px', borderRadius: 8, background: TP.amberSoft, border: `1px solid rgba(245,158,11,0.3)`, color: TP.amberDeep, fontSize: 12, fontWeight: 500 }}>
          <T_Shield size={13}/>Unlisted — visible only to people with the link. Not indexed in the Store.
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '14px 0 12px' }}>
        <T_Avatar name={tool.author} color={tool.authorColor} size={46}/>
        <div>
          <div style={{ fontSize: 30, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1.05 }}>{tool.title || tool.name}</div>
          <div style={{ fontSize: 13, color: TP.mute, marginTop: 4 }}>{(tool.author || '').replace('@', '')} · {tpFmtN(tool.installs)} installs</div>
        </div>
      </div>
      <div style={{ fontSize: 16.5, color: TP.text, lineHeight: 1.5, marginBottom: 18 }}>{tool.tagline}</div>
      <div style={{ display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap' }}>
        <InstallButton tool={tool} installed={installed}/>
        {tool.widgets.length === 0 && <T_Btn kind="secondary" size="lg"><TC.IconCopy size={15}/>Copy MCP config</T_Btn>}
      </div>
    </div>
  );
}

// ── Desktop tool page (tabbed: Widgets · Functions · Trust) ───────────────────
function ToolPageDesktop({ toolKey = 'weather', installed = false, unlisted = false }) {
  const tool = toolKey === 'fx' ? window.LaunchData.TOOL_FX : window.LaunchData.TOOL_WEATHER;
  const builderRank = toolKey === 'fx' ? 3 : 1;
  const hasWidgets = tool.widgets.length > 0;
  const tabs = hasWidgets
    ? [['widgets', 'Widgets'], ['functions', 'Functions'], ['trust', 'Details']]
    : [['functions', 'Functions'], ['trust', 'Details']];
  const [tab, setTab] = React.useState(tabs[0][0]);
  const [fnSel, setFnSel] = React.useState(tool.functions[0]?.name);
  const [wgSel, setWgSel] = React.useState(tool.widgets[0]?.id);
  return (
    <T_Browser url={`ultralight.dev/tools/${tool.slug}`} width={1280} height={880}>
      <T_TopNav active="store" signedIn={installed} cta={false}/>
      <T_Scroll>
        <div style={{ maxWidth: 880, margin: '0 auto', padding: '51px 32px 60px', fontFamily: TP.font }}>
          <ToolHeader tool={tool} installed={installed} unlisted={unlisted}/>
          <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${TP.border}`, marginBottom: 22, overflow: 'visible' }}>
            {tabs.map(([id, label]) => (
              id === 'functions'
                ? <TabDropdown key={id} label="Functions" active={tab === 'functions'} options={tool.functions.map((f) => ({ id: f.name, label: f.name, desc: f.desc }))} sel={fnSel} onSelect={setFnSel} onActivate={() => setTab('functions')}/>
                : id === 'widgets'
                ? <TabDropdown key={id} label="Widgets" active={tab === 'widgets'} options={tool.widgets.map((w) => ({ id: w.id, label: w.label, desc: w.description }))} sel={wgSel} onSelect={setWgSel} onActivate={() => setTab('widgets')}/>
                : <span key={id} onClick={() => setTab(id)} style={{ fontSize: 13, fontWeight: tab === id ? 600 : 500, color: tab === id ? TP.text : TP.mute, padding: '9px 11px', borderBottom: `2px solid ${tab === id ? TP.text : 'transparent'}`, marginBottom: -1, cursor: 'pointer', whiteSpace: 'nowrap' }}>{label}</span>
            ))}
          </div>
          {tab === 'widgets' && <WidgetsTab tool={tool} sel={wgSel}/>}
          {tab === 'functions' && <FunctionsTab tool={tool} sel={fnSel}/>}
          {tab === 'trust' && <TrustTab tool={tool} builderRank={builderRank}/>}
        </div>
      </T_Scroll>
    </T_Browser>
  );
}

window.LaunchToolPage = {
  ToolPageDesktop, InstallButton, Sandbox, FnTable, WidgetPreview, TrustRail, ToolHeader, ForecastCard, NowBadge,
  WidgetsTab, FunctionsTab, TrustTab, FunctionSandbox, WidgetSandboxFrame, WidgetSandboxBody, Picker, PermissionControl,
};
