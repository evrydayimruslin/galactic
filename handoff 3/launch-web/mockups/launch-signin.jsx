// launch-signin.jsx — Sign-in popup. Public browsing needs no auth; this modal
// appears when an action requires an account (install with your key, wallet,
// owner admin). Post-auth, the user can act immediately (token stored as
// localStorage 'ultralight.launch.authToken'). Canonical AuthGate copy.

const { L: SC } = window.LaunchData;
const { LWordmark: S_Wordmark, LBtn: S_Btn, BrowserFrame: S_Browser, PhoneFrame: S_Phone, LTopNav: S_TopNav, LMobileBar: S_MobileBar, IconClose: S_IconClose } = window.LaunchChrome;

// Google "G" — white monochrome mark, matching the desktop AuthGate button.
function GoogleG({ size = 16, color = '#fff' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M21.6 12.2c0-.7-.06-1.35-.18-2H12v3.85h5.4a4.6 4.6 0 0 1-2 3v2.5h3.23c1.9-1.74 2.97-4.3 2.97-7.35z" fill={color} opacity="0.95"/>
      <path d="M12 22c2.7 0 4.96-.9 6.62-2.43l-3.23-2.5c-.9.6-2.04.95-3.39.95-2.6 0-4.8-1.76-5.59-4.12H3.07v2.58A10 10 0 0 0 12 22z" fill={color} opacity="0.7"/>
      <path d="M6.41 13.9a6 6 0 0 1 0-3.8V7.52H3.07a10 10 0 0 0 0 8.97l3.34-2.59z" fill={color} opacity="0.5"/>
      <path d="M12 5.98c1.47 0 2.79.5 3.83 1.5l2.86-2.86C16.95 2.99 14.7 2 12 2A10 10 0 0 0 3.07 7.52l3.34 2.58C7.2 7.74 9.4 5.98 12 5.98z" fill={color} opacity="0.85"/>
    </svg>
  );
}

// ── Modal body — shared between desktop + mobile ───────────────────────────────
function SignInBody({ state = 'default', compact = false }) {
  const authing = state === 'authenticating';
  return (
    <div style={{ padding: compact ? '30px 26px 26px' : '38px 40px 32px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
      <S_Wordmark size={compact ? 22 : 25}/>
      {state === 'another' && (
        <div style={{ fontSize: compact ? 15 : 16, fontWeight: 600, marginTop: 20, color: SC.text, letterSpacing: '-0.01em' }}>Use another account</div>
      )}

      <div style={{ width: '100%', maxWidth: 300, marginTop: state === 'another' ? 22 : 24, display: 'flex', flexDirection: 'column', gap: 9 }}>
        <button style={{ height: 44, borderRadius: 10, border: 'none', background: SC.text, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, fontSize: 14, fontWeight: 500, fontFamily: SC.font, cursor: 'pointer', opacity: authing ? 0.85 : 1 }}>
          {authing
            ? <React.Fragment><span style={{ width: 14, height: 14, border: '2px solid rgba(255,255,255,0.35)', borderTopColor: '#fff', borderRadius: 9999, animation: 'pui-spin 0.7s linear infinite' }}/>Opening Google…</React.Fragment>
            : <React.Fragment><GoogleG size={17}/>Sign in with Google</React.Fragment>}
        </button>
        {state !== 'another'
          ? <button style={{ height: 42, borderRadius: 10, border: `1px solid ${SC.border}`, background: SC.raised, color: SC.sec, fontSize: 13.5, fontWeight: 500, fontFamily: SC.font, cursor: 'pointer' }}>Use another account</button>
          : <button style={{ height: 42, borderRadius: 10, border: `1px solid ${SC.border}`, background: '#fff', color: SC.sec, fontSize: 13.5, fontWeight: 500, fontFamily: SC.font, cursor: 'pointer' }}>← Back</button>}
      </div>

      <div style={{ fontFamily: SC.font, fontSize: 13.5, color: SC.sec, marginTop: 18, maxWidth: 260, lineHeight: 1.5 }}>
        {authing ? 'Complete sign-in in your browser.' : 'Sign in to use or deploy tools.'}
      </div>
    </div>
  );
}

// Real Store page behind the scrim (dimmed) — gives the popup accurate context.
function GhostPage() {
  const Backdrop = window.LaunchDiscover && window.LaunchDiscover.DiscoverBackdrop;
  return (
    <div style={{ pointerEvents: 'none' }}>{Backdrop ? <Backdrop/> : null}</div>
  );
}

function SignInDesktop({ state = 'default' }) {
  return (
    <S_Browser url="ultralight.dev/store" width={1180} height={760}>
      <S_TopNav active="store"/>
      <div style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <GhostPage/>
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(10,10,10,0.28)', backdropFilter: 'blur(1.5px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'relative', width: 400, background: '#fff', borderRadius: 16, border: `1px solid ${SC.border}`, boxShadow: '0 24px 60px rgba(0,0,0,0.18)' }}>
            <button style={{ position: 'absolute', top: 14, right: 14, width: 28, height: 28, borderRadius: 8, border: 'none', background: 'transparent', color: SC.mute, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><S_IconClose size={16}/></button>
            <SignInBody state={state}/>
          </div>
        </div>
      </div>
    </S_Browser>
  );
}

function SignInMobile({ state = 'default' }) {
  const Backdrop = window.LaunchDiscover && window.LaunchDiscover.DiscoverBackdropMobile;
  return (
    <S_Phone width={390} height={780}>
      <S_MobileBar/>
      <div style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <div style={{ pointerEvents: 'none' }}>{Backdrop ? <Backdrop/> : null}</div>
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(10,10,10,0.30)', backdropFilter: 'blur(1.5px)', display: 'flex', alignItems: 'flex-end' }}>
          <div style={{ width: '100%', background: '#fff', borderRadius: '18px 18px 0 0', boxShadow: '0 -8px 40px rgba(0,0,0,0.16)' }}>
            <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 10 }}>
              <span style={{ width: 38, height: 4, borderRadius: 9999, background: 'rgba(0,0,0,0.14)' }}/>
            </div>
            <SignInBody state={state} compact/>
          </div>
        </div>
      </div>
    </S_Phone>
  );
}

window.LaunchSignIn = { SignInDesktop, SignInMobile };
