// launch-install.jsx — Install / external-agent onboarding /install (desktop +
// mobile) + states. Backend: GET /api/launch/install → LaunchInstallInstruction[]
// (target/steps/configText/requiresApiKey). Signed-in users get their API key
// injected straight into the copyable config; signed-out shows a placeholder.

const { L: I, INSTALL_TARGETS, API_KEY, API_KEY_MASK } = window.LaunchData;
const IC = window.LaunchChrome;
const {
  LMono: I_Mono, LLabel: I_Label, LBtn: I_Btn, LTopNav: I_TopNav, LMobileBar: I_Bar,
  BrowserFrame: I_Browser, PhoneFrame: I_Phone, LScroll: I_Scroll,
  IconCopy: I_Copy, IconKey, IconTerminal: I_Term, IconArrowRight: I_Arr, IconShield: I_Shield,
} = window.LaunchChrome;
const KeyIcon = window.PUI_Icons.IconKey;

const KEY_PLACEHOLDER = '$ULTRALIGHT_API_KEY';

// ── Config block (dark) with the API-key substring highlighted ────────────────
function ConfigBlock({ text, keyStr, copied }) {
  const parts = [];
  let rest = text, idx;
  while ((idx = rest.indexOf(keyStr)) !== -1) {
    if (idx > 0) parts.push({ t: rest.slice(0, idx) });
    parts.push({ t: keyStr, key: true });
    rest = rest.slice(idx + keyStr.length);
  }
  if (rest) parts.push({ t: rest });
  return (
    <div style={{ position: 'relative', borderRadius: 10, overflow: 'hidden', border: `1px solid ${I.borderStrong}` }}>
      <button style={{ position: 'absolute', top: 9, right: 9, display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: I.font, fontSize: 11.5, fontWeight: 500, color: copied ? '#a7f3d0' : '#e5e7eb', background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: 7, padding: '5px 10px', cursor: 'pointer' }}>
        {copied ? <React.Fragment><IC.IconShield size={13}/>Copied</React.Fragment> : <React.Fragment><I_Copy size={13}/>Copy</React.Fragment>}
      </button>
      <pre style={{ margin: 0, padding: '14px 16px', background: '#111827', color: '#e5e7eb', fontSize: 12, fontFamily: I.mono, lineHeight: 1.6, whiteSpace: 'pre', overflowX: 'auto' }}>
{parts.map((p, i) => p.key
  ? <span key={i} style={{ color: '#fcd34d', background: 'rgba(252,211,77,0.12)', borderRadius: 3, padding: '0 2px' }}>{p.t}</span>
  : <span key={i}>{p.t}</span>)}
      </pre>
    </div>
  );
}

// ── Key banner — signed-in vs signed-out ──────────────────────────────────────
function KeyBanner({ signedIn }) {
  if (signedIn) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 10, border: `1px solid ${I.border}`, background: I.greenSoft }}>
        <span style={{ width: 32, height: 32, borderRadius: 8, background: '#fff', border: `1px solid ${I.border}`, display: 'grid', placeItems: 'center', color: I.greenDeep }}><KeyIcon size={16}/></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Your API key is included below</div>
          <div style={{ fontSize: 11.5, color: I.sec, marginTop: 1 }}>Copy any snippet and it’s ready to run — <I_Mono size={11}>{API_KEY_MASK}</I_Mono></div>
        </div>
        <I_Btn kind="secondary" size="sm"><I_Copy size={13}/>Copy key</I_Btn>
        <I_Btn kind="ghost" size="sm">Regenerate</I_Btn>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 10, border: `1px solid ${I.border}`, background: I.raised }}>
      <span style={{ width: 32, height: 32, borderRadius: 8, background: '#fff', border: `1px solid ${I.border}`, display: 'grid', placeItems: 'center', color: I.mute }}><KeyIcon size={16}/></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Sign in to drop your key into these snippets</div>
        <div style={{ fontSize: 11.5, color: I.sec, marginTop: 1 }}>Until then they show <I_Mono size={11}>{KEY_PLACEHOLDER}</I_Mono> — replace it with your own token.</div>
      </div>
      <I_Btn kind="primary" size="sm">Sign in</I_Btn>
    </div>
  );
}

// ── External-agent loop (from LAUNCH status.externalAgentLoop) ─────────────────
function ExternalLoop() {
  const steps = ['Install MCP / CLI / API', 'Discover tools + primitives', 'Inspect pricing, trust, widgets', 'Call through MCP / API', 'Return widget links + receipts'];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {steps.map((s, i) => (
        <React.Fragment key={i}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: I.sec, background: I.raised, border: `1px solid ${I.border}`, borderRadius: 8, padding: '7px 11px' }}>
            <I_Mono size={11} color={I.mute}>{i + 1}</I_Mono>{s}
          </span>
          {i < steps.length - 1 && <span style={{ color: I.faint }}><I_Arr size={13}/></span>}
        </React.Fragment>
      ))}
    </div>
  );
}

// ── Target list (grouped) ───────────────────────────────────────────────────────
function TargetList({ active, onPick, vertical }) {
  const groups = [['MCP', 'Remote MCP servers'], ['Direct', 'CLI & API']];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {groups.map(([g, sub]) => (
        <div key={g}>
          <I_Label mb={8}>{sub}</I_Label>
          <div style={{ display: 'flex', flexDirection: vertical ? 'column' : 'row', flexWrap: 'wrap', gap: 7 }}>
            {INSTALL_TARGETS.filter((t) => t.group === g).map((t) => (
              <button key={t.target} onClick={() => onPick(t.target)} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 9, cursor: 'pointer', fontFamily: I.font, fontSize: 13, fontWeight: 500, border: `1px solid ${active === t.target ? I.text : I.border}`, background: active === t.target ? I.text : '#fff', color: active === t.target ? '#fff' : I.text, justifyContent: vertical ? 'flex-start' : 'center' }}>
                {g === 'MCP' ? <IC.IconCircuit size={14}/> : <I_Term size={14}/>}{t.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Selected target panel ───────────────────────────────────────────────────────
function TargetPanel({ target, signedIn, copied }) {
  const t = INSTALL_TARGETS.find((x) => x.target === target) || INSTALL_TARGETS[0];
  const key = signedIn ? API_KEY : KEY_PLACEHOLDER;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.015em' }}>{t.label}</span>
        {t.requiresApiKey && <I_Mono size={11} color={I.mute} style={{ whiteSpace: 'nowrap' }}>requires API key</I_Mono>}
      </div>
      <div style={{ fontSize: 13.5, color: I.sec, lineHeight: 1.5, marginBottom: 16, maxWidth: 620 }}>{t.description}</div>
      <ol style={{ margin: '0 0 16px', padding: '0 0 0 18px', color: I.text, fontSize: 13, lineHeight: 1.7 }}>
        {t.steps.map((s, i) => <li key={i} style={{ marginBottom: 2 }}>{s}</li>)}
      </ol>
      <ConfigBlock text={t.config(key)} keyStr={key} copied={copied}/>
    </div>
  );
}

// ── Desktop ───────────────────────────────────────────────────────────────────
function InstallDesktop({ signedIn = false, target = 'claude_code', copied = false }) {
  return (
    <I_Browser url="ultralight.dev/install" width={1280} height={900}>
      <I_TopNav active="" signedIn={signedIn}/>
      <I_Scroll>
        <div style={{ maxWidth: 1080, margin: '0 auto', padding: '51px 32px 56px', fontFamily: I.font }}>
          <I_Label mb={8}>Install</I_Label>
          <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1.05, marginBottom: 10 }}>Connect Ultralight to your agent.</div>
          <div style={{ fontSize: 16, color: I.sec, lineHeight: 1.5, marginBottom: 20, maxWidth: 640 }}>One remote MCP endpoint — or the CLI and API — lets any existing agent discover, call, and pay for tools.</div>
          <div style={{ marginBottom: 24 }}><ExternalLoop/></div>
          <div style={{ marginBottom: 22 }}><KeyBanner signedIn={signedIn}/></div>
          <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 32, alignItems: 'flex-start' }}>
            <div style={{ position: 'sticky', top: 16 }}><TargetList active={target} onPick={() => {}}/></div>
            <TargetPanel target={target} signedIn={signedIn} copied={copied}/>
          </div>
        </div>
      </I_Scroll>
    </I_Browser>
  );
}

// ── Mobile ───────────────────────────────────────────────────────────────────
function InstallMobile({ signedIn = true, target = 'claude_code' }) {
  const [tg, setTg] = React.useState(target);
  return (
    <I_Phone width={390} height={860}>
      <I_Bar signedIn={signedIn}/>
      <I_Scroll>
        <div style={{ padding: '16px 16px 40px', fontFamily: I.font }}>
          <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 8 }}>Install</div>
          <div style={{ fontSize: 13.5, color: I.sec, lineHeight: 1.5, marginBottom: 16 }}>Connect any MCP-capable agent — Claude Code, Cursor, Codex — or use the CLI and API.</div>
          <div style={{ marginBottom: 18 }}><KeyBanner signedIn={signedIn}/></div>
          <div style={{ marginBottom: 18 }}>
            <I_Label mb={8}>Choose a target</I_Label>
            <div style={{ display: 'flex', gap: 7, overflowX: 'auto', paddingBottom: 4 }}>
              {INSTALL_TARGETS.map((t) => (
                <button key={t.target} onClick={() => setTg(t.target)} style={{ flexShrink: 0, padding: '7px 12px', borderRadius: 9, fontFamily: I.font, fontSize: 12.5, fontWeight: 500, cursor: 'pointer', border: `1px solid ${tg === t.target ? I.text : I.border}`, background: tg === t.target ? I.text : '#fff', color: tg === t.target ? '#fff' : I.text }}>{t.label}</button>
              ))}
            </div>
          </div>
          <TargetPanel target={tg} signedIn={signedIn} copied={false}/>
        </div>
      </I_Scroll>
    </I_Phone>
  );
}

window.LaunchInstall = { InstallDesktop, InstallMobile };
