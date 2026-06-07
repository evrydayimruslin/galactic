// launch-settings.jsx — Settings /settings (desktop + mobile) + states.
// Backend: account profile + API-key management (create / list / revoke) — the
// key issuance that GET /api/launch/install assumes but no contract defines yet.
// Launch-safe preferences only (no BYOK / desktop / agent surfaces).

const { L: S2, API_KEY: S2_KEY, API_KEY_MASK: S2_MASK } = window.LaunchData;
const S2C = window.LaunchChrome;
const {
  LMono: S2_Mono, LLabel: S2_Label, LBtn: S2_Btn, LAvatar: S2_Avatar,
  LTopNav: S2_TopNav, LMobileBar: S2_Bar, BrowserFrame: S2_Browser, PhoneFrame: S2_Phone, LScroll: S2_Scroll,
  IconCopy: S2_Copy, IconShield: S2_Shield, IconClose: S2_Close,
} = window.LaunchChrome;
const S2_Key = window.PUI_Icons.IconKey;

const KEYS = [
  { name: 'Claude Code · laptop', prefix: 'ulk_live_••••4xN4', scopes: 'mcp · api', created: '12 Apr', lastUsed: '2m' },
  { name: 'CI deploy', prefix: 'ulk_live_••••9aQ2', scopes: 'cli', created: '3 Mar', lastUsed: '1d' },
  { name: 'Cursor', prefix: 'ulk_live_••••7bX1', scopes: 'mcp', created: '28 Feb', lastUsed: '6d' },
];

function Card({ title, sub, action, children }) {
  return (
    <div style={{ border: `1px solid ${S2.border}`, borderRadius: 12, background: '#fff', marginBottom: 16, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '14px 16px', borderBottom: `1px solid ${S2.border}` }}>
        <div><div style={{ fontSize: 14.5, fontWeight: 600 }}>{title}</div>{sub && <div style={{ fontSize: 12, color: S2.sec, marginTop: 2 }}>{sub}</div>}</div>
        {action}
      </div>
      <div style={{ padding: '6px 16px 14px' }}>{children}</div>
    </div>
  );
}

function KeyRow({ k }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0', borderTop: `1px solid ${S2.border}` }}>
      <span style={{ color: S2.mute }}><S2_Key size={15}/></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.name}</div>
        <S2_Mono size={11.5} color={S2.mute}>{k.prefix} · {k.scopes}</S2_Mono>
      </div>
      <div style={{ textAlign: 'right' }}><S2_Label mb={2}>Last used</S2_Label><S2_Mono size={11.5} color={S2.sec}>{k.lastUsed}</S2_Mono></div>
      <span style={{ fontSize: 12.5, color: S2.red, cursor: 'pointer', fontWeight: 500 }}>Revoke</span>
    </div>
  );
}

function Toggle({ on = true }) {
  return <span style={{ width: 34, height: 20, borderRadius: 9999, background: on ? S2.text : 'rgba(0,0,0,0.18)', padding: 2, boxSizing: 'border-box', flexShrink: 0 }}><span style={{ display: 'block', width: 16, height: 16, borderRadius: 9999, background: '#fff', transform: `translateX(${on ? 14 : 0}px)`, boxShadow: '0 1px 2px rgba(0,0,0,0.25)' }}/></span>;
}
function PrefRow({ title, sub, control, first }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 0', borderTop: first ? 'none' : `1px solid ${S2.border}` }}>
      <div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 500 }}>{title}</div><div style={{ fontSize: 11.5, color: S2.sec, marginTop: 1 }}>{sub}</div></div>
      {control}
    </div>
  );
}
function Select({ value }) {
  return <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '7px 12px', border: `1px solid ${S2.border}`, borderRadius: 8, fontSize: 13.5, fontWeight: 500, fontFamily: S2.font }}>{value}<span style={{ color: S2.mute, fontSize: 10 }}>▾</span></div>;
}

function SettingsBody({ mobile, empty }) {
  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: mobile ? '10px 16px 40px' : '51px 32px 56px', fontFamily: S2.font }}>

      <div style={{ display: 'flex', alignItems: 'center', gap: 13, marginBottom: 18 }}>
        <S2_Avatar name="@you" color="#0a0a0a" size={42}/>
        <div style={{ flex: 1 }}><div style={{ fontSize: 16, fontWeight: 600 }}>Ada Lovelace</div><div style={{ fontSize: 12.5, color: S2.sec, marginTop: 1 }}>ada@analytical.engine · @you</div></div>
        <S2_Btn kind="secondary" size="sm">Sign out</S2_Btn>
      </div>

      <Card title="API key" sub="One token your agents use to call Ultralight.">
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 0 4px' }}>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 13px', border: `1px solid ${S2.border}`, borderRadius: 9, background: S2.raised, minWidth: 0 }}>
            <span style={{ color: S2.mute, display: 'inline-flex', flexShrink: 0 }}><S2_Key size={15}/></span>
            <S2_Mono size={13} style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{S2_MASK}</S2_Mono>
          </div>
          <S2_Btn kind="secondary" size="sm"><S2_Copy size={13}/>Copy</S2_Btn>
          <S2_Btn kind="secondary" size="sm">Rotate &amp; copy</S2_Btn>
        </div>
        <div style={{ fontSize: 11.5, color: S2.mute, marginTop: 6 }}>Rotating issues a new key and revokes the old one — connected agents must be updated.</div>
      </Card>

      <Card title="Preferences" sub="Launch-safe defaults.">
        <PrefRow first title="Default new tool permissions" sub="How agents may call functions on tools you deploy." control={<Select value="Always ask"/>}/>
        <PrefRow title="Default installed tool permissions" sub="How agents may call functions on tools you install." control={<Select value="Always ask"/>}/>
      </Card>

      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 14px', borderRadius: 11, border: `1px solid ${S2.border}`, background: S2.raised, marginBottom: 16 }}>
        <span style={{ width: 32, height: 32, borderRadius: 8, background: '#fff', border: `1px solid ${S2.border}`, display: 'grid', placeItems: 'center', color: S2.mute, flexShrink: 0 }}><window.LaunchChrome.IconCopy size={15}/></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Connecting an agent?</div>
          <div style={{ fontSize: 11.5, color: S2.sec, marginTop: 1 }}>Use <strong style={{ color: S2.text }}>Add to agent</strong> — it bundles your API key automatically. Or manage the key directly above.</div>
        </div>
        <window.LaunchChrome.CopyAgentBtn size="sm" short/>
      </div>
    </div>
  );
}

// ── Reveal-once new-key modal (a state) ───────────────────────────────────────
function NewKeyModal() {
  return (
    <S2_Browser url="ultralight.dev/settings" width={840} height={560}>
      <S2_TopNav active="settings" signedIn balance={12.40}/>
      <div style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <div style={{ padding: '26px 32px', filter: 'saturate(0.6)', opacity: 0.5 }}>
          <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 16 }}>Profile</div>
          <div style={{ height: 80, border: `1px solid ${S2.border}`, borderRadius: 12, marginBottom: 14 }}/>
          <div style={{ height: 120, border: `1px solid ${S2.border}`, borderRadius: 12 }}/>
        </div>
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(10,10,10,0.20)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 460, background: '#fff', borderRadius: 16, border: `1px solid ${S2.border}`, boxShadow: '0 16px 50px rgba(0,0,0,0.12)', padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <span style={{ width: 34, height: 34, borderRadius: 9, background: S2.greenSoft, display: 'grid', placeItems: 'center', color: S2.greenDeep }}><S2_Key size={17}/></span>
              <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.015em' }}>API key created</div>
            </div>
            <div style={{ fontSize: 13, color: S2.sec, lineHeight: 1.5, marginBottom: 16 }}>Copy it now — for your security, <strong style={{ color: S2.text }}>you won’t be able to see it again.</strong></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 10, background: '#111827', marginBottom: 16 }}>
              <S2_Mono size={13} style={{ color: '#fcd34d', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{S2_KEY}</S2_Mono>
              <button style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: S2.font, fontSize: 12, fontWeight: 500, color: '#e5e7eb', background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: 7, padding: '6px 10px', cursor: 'pointer' }}><S2_Copy size={13}/>Copy</button>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <S2_Btn kind="secondary" size="sm">Add to install config</S2_Btn>
              <S2_Btn kind="primary" size="sm">Done</S2_Btn>
            </div>
          </div>
        </div>
      </div>
    </S2_Browser>
  );
}

function SettingsDesktop({ empty = false }) {
  return (
    <S2_Browser url="ultralight.dev/settings" width={1180} height={820}>
      <S2_TopNav active="settings" signedIn balance={12.40}/>
      <S2_Scroll><SettingsBody empty={empty}/></S2_Scroll>
    </S2_Browser>
  );
}
function SettingsMobile() {
  return (
    <S2_Phone width={390} height={860}>
      <S2_Bar signedIn balance={12.40} title="Profile"/>
      <S2_Scroll><SettingsBody mobile/></S2_Scroll>
    </S2_Phone>
  );
}

window.LaunchSettings = { SettingsDesktop, SettingsMobile, NewKeyModal };
