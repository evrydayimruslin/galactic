// launch-widget.jsx — Widget open surface /tools/:slug?widget=:id.
// Widgets are developer-authored HTML returned by widget_<id>_ui and rendered in
// a sandboxed iframe. The widget NEVER receives the user's API key — the shell
// injects an ulAction(...) bridge that relays calls through a short-lived backend
// widget session. States: loading · ready · error · setup-required.

const { L: WG } = window.LaunchData;
const WGC = window.LaunchChrome;
const {
  LMono: WG_Mono, LLabel: WG_Label, LBtn: WG_Btn, LAvatar: WG_Avatar,
  LTopNav: WG_TopNav, LMobileBar: WG_Bar, BrowserFrame: WG_Browser, PhoneFrame: WG_Phone, LScroll: WG_Scroll,
  IconClose: WG_Close, IconShield: WG_Shield, IconExternal: WG_Ext,
} = window.LaunchChrome;
const { ForecastCard: WG_Forecast } = window.LaunchToolPage;
const { TrustSetupCard: WG_Trust } = window.LaunchTrust;

const META = {
  weather: { tool: 'get_weather', author: '@kepler', color: '#7c3aed', widget: 'Forecast card', wid: 'forecast_card', signedIn: false, trust: 'ready', fn: 'forecast', args: "{ city: 'Tokyo' }" },
  gmail: { tool: 'gmail.send', author: '@hex', color: '#22c55e', widget: 'Compose', wid: 'compose', signedIn: true, trust: 'setup', fn: 'send', args: '{ to, subject, body }' },
};

// ── The hatched iframe body (sandbox) ─────────────────────────────────────────
function IframeBody({ children, tall }) {
  return (
    <div style={{ position: 'relative', minHeight: tall ? 340 : 280, background: 'repeating-linear-gradient(45deg, #fcfcfc, #fcfcfc 10px, #fafafa 10px, #fafafa 20px)', display: 'grid', placeItems: 'center', padding: 24 }}>
      <span style={{ position: 'absolute', top: 8, right: 10, fontFamily: WG.mono, fontSize: 9.5, color: WG.faint, letterSpacing: '0.06em', textTransform: 'uppercase' }}>iframe · sandboxed</span>
      {children}
    </div>
  );
}

function Spinner({ size = 18 }) {
  return <span style={{ width: size, height: size, border: `2px solid ${WG.border}`, borderTopColor: WG.text, borderRadius: 9999, display: 'inline-block', animation: 'pui-spin 0.7s linear infinite' }}/>;
}

// ── Ready widget app (developer-authored content) ─────────────────────────────
function ReadyWidget() {
  return (
    <div style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${WG.border}`, borderRadius: 9, padding: '8px 11px', background: '#fff' }}>
          <span style={{ color: WG.mute }}><window.PUI_Icons.IconSearch size={14}/></span>
          <span style={{ fontSize: 13, color: WG.text }}>Tokyo</span>
        </div>
        <button style={{ width: 38, borderRadius: 9, border: `1px solid ${WG.border}`, background: '#fff', cursor: 'pointer', color: WG.sec }}>↻</button>
      </div>
      <WG_Forecast/>
      <div style={{ textAlign: 'center', fontFamily: WG.mono, fontSize: 10, color: WG.mute }}>powered by get_weather</div>
    </div>
  );
}

function StateBody({ kind, state }) {
  const m = META[kind];
  if (state === 'loading') return (
    <IframeBody>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <Spinner size={22}/>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Starting widget session…</div>
        <WG_Mono size={11} color={WG.mute}>POST /api/widget-session → {m.wid}</WG_Mono>
      </div>
    </IframeBody>
  );
  if (state === 'error') return (
    <IframeBody>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center', maxWidth: 360 }}>
        <span style={{ width: 44, height: 44, borderRadius: 11, background: WG.errorSoft || 'rgba(239,68,68,0.08)', display: 'grid', placeItems: 'center', color: WG.red }}><WG_Shield size={20}/></span>
        <div style={{ fontSize: 16, fontWeight: 600 }}>Couldn’t load this widget</div>
        <div style={{ fontSize: 12.5, color: WG.sec, lineHeight: 1.5 }}>The widget UI function failed to render. Your balance wasn’t charged.</div>
        <WG_Mono size={10.5} color={WG.red}>widget_{m.wid}_ui → 500 · session aborted</WG_Mono>
        <div style={{ display: 'flex', gap: 8, marginTop: 2 }}><WG_Btn kind="primary" size="sm">Retry</WG_Btn><WG_Btn kind="secondary" size="sm">Report</WG_Btn></div>
      </div>
    </IframeBody>
  );
  if (state === 'setup') return (
    <IframeBody>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center', maxWidth: 380 }}>
        <span style={{ width: 44, height: 44, borderRadius: 11, background: WG.amberSoft, display: 'grid', placeItems: 'center', color: WG.amberDeep }}><WG_Shield size={20}/></span>
        <div style={{ fontSize: 16, fontWeight: 600 }}>Connect Gmail to use this widget</div>
        <div style={{ fontSize: 12.5, color: WG.sec, lineHeight: 1.55 }}>gmail.send needs permission to send on your behalf before this widget can run. You’ll be routed to your account settings — your API key is never shared with the widget.</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 2 }}><WG_Btn kind="primary" size="sm">Connect Gmail</WG_Btn><WG_Btn kind="ghost" size="sm">Why is this needed?</WG_Btn></div>
      </div>
    </IframeBody>
  );
  return <IframeBody tall><ReadyWidget/></IframeBody>;
}

// ── Shell (header + body + relay footer) ───────────────────────────────────────
function WidgetShell({ kind, state }) {
  const m = META[kind];
  return (
    <div style={{ border: `1px solid ${WG.borderStrong}`, borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderBottom: `1px solid ${WG.border}`, background: WG.raised }}>
        <WG_Avatar name={m.author} color={m.color} size={22}/>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{m.widget}</div>
          <WG_Mono size={10.5} color={WG.mute}>{m.tool} · widget</WG_Mono>
        </div>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: WG.mono, fontSize: 10.5, color: WG.sec, border: `1px solid ${WG.border}`, borderRadius: 7, padding: '4px 8px' }}><WG_Shield size={12}/>relayed · no key</span>
        <button style={{ width: 28, height: 28, borderRadius: 8, border: 'none', background: 'transparent', color: WG.mute, cursor: 'pointer', display: 'grid', placeItems: 'center' }}><WG_Close size={16}/></button>
      </div>
      <StateBody kind={kind} state={state}/>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderTop: `1px solid ${WG.border}`, background: '#0b1220' }}>
        <span style={{ color: '#a7f3d0', display: 'inline-flex' }}><WG_Shield size={13}/></span>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', flex: 1, lineHeight: 1.4 }}>Calls relay through Ultralight — the widget never sees your API key.</span>
        <WG_Mono size={10.5} color="rgba(255,255,255,0.55)">ulAction('{m.fn}', {m.args})</WG_Mono>
        {state === 'ready' && <WG_Mono size={10.5} color="#fcd34d">session 4:58</WG_Mono>}
      </div>
    </div>
  );
}

// ── Desktop ───────────────────────────────────────────────────────────────────
function WidgetDesktop({ kind = 'weather', state = 'ready' }) {
  const m = META[kind];
  return (
    <WG_Browser url={`ultralight.dev/tools/${m.tool}?widget=${m.wid}`} width={1180} height={780}>
      <WG_TopNav active="store" signedIn={m.signedIn}/>
      <WG_Scroll>
        <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px 32px 48px', fontFamily: WG.font }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18, fontSize: 13, color: WG.sec, cursor: 'pointer' }}>← <span style={{ fontFamily: WG.mono }}>{m.tool}</span> · {m.widget}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 28, alignItems: 'flex-start' }}>
            <WidgetShell kind={kind} state={state}/>
            <WG_Trust variant={m.trust}/>
          </div>
        </div>
      </WG_Scroll>
    </WG_Browser>
  );
}

// ── Mobile ───────────────────────────────────────────────────────────────────
function WidgetMobile({ kind = 'weather', state = 'ready' }) {
  const m = META[kind];
  return (
    <WG_Phone width={390} height={820}>
      <WG_Bar signedIn={m.signedIn} title={m.widget}/>
      <WG_Scroll>
        <div style={{ padding: '16px 16px 40px', fontFamily: WG.font }}>
          <div style={{ marginBottom: 12, fontSize: 12.5, color: WG.sec }}>← <span style={{ fontFamily: WG.mono }}>{m.tool}</span></div>
          <WidgetShell kind={kind} state={state}/>
          <div style={{ marginTop: 14 }}><WG_Trust variant={m.trust}/></div>
        </div>
      </WG_Scroll>
    </WG_Phone>
  );
}

window.LaunchWidget = { WidgetDesktop, WidgetMobile };
