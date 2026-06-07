// launch-admin.jsx — Owner admin /admin/tools/:id (desktop + mobile) + states.
// Owner-only. Backend: GET /api/launch/admin/tools/:id → LaunchToolAdminSummary {
//   tool: LaunchToolSummary, editableFields:[name,description,visibility,pricing,
//   widgets,secrets,trust], receiptsUrl, logsUrl }.

const { L: AD, TOOL_WEATHER: A_TOOL, fmtN: aN } = window.LaunchData;
const AC = window.LaunchChrome;
const {
  LMono: A_Mono, LLabel: A_Label, LBtn: A_Btn, LAvatar: A_Avatar, LKindBadge: A_Kind, LTrustStamp: A_Trust,
  LCapPill: A_Cap, LTopNav: A_TopNav, LMobileBar: A_Bar, BrowserFrame: A_Browser, PhoneFrame: A_Phone, LScroll: A_Scroll,
  IconExternal: A_Ext, IconShield: A_Shield, IconCopy: A_Copy,
} = window.LaunchChrome;
const A_Key = window.PUI_Icons.IconKey;

const ATABS = [['edit', 'Edit'], ['pricing', 'Pricing'], ['widgets', 'Widgets'], ['secrets', 'Secrets'], ['trust', 'Trust'], ['receipts', 'Receipts'], ['logs', 'Logs']];
const VIS = [
  ['public', 'Public', 'Listed in the Store, embeddable widgets, installable by anyone.'],
  ['unlisted', 'Unlisted', 'Reachable by direct link only. Not indexed in the Store.'],
  ['private', 'Private', 'Only you can see and call it. Hidden everywhere else.'],
];
const SECRETS = [
  { key: 'OPENWEATHER_API_KEY', set: true },
  { key: 'NOAA_TOKEN', set: true },
  { key: 'CACHE_TTL_SECONDS', set: false },
];
const ADMIN_RECEIPTS = [
  { caller: '@arbiter', fn: 'forecast', light: 0.012, when: '1m', status: 'ok' },
  { caller: 'agent_7f', fn: 'now', light: 0.004, when: '3m', status: 'ok' },
  { caller: '@nimbus', fn: 'historical', light: 0.018, when: '12m', status: 'ok' },
  { caller: 'agent_2b', fn: 'alerts', light: 0.006, when: '28m', status: 'error' },
];
const LOGS = [
  { fn: 'forecast', ms: 142, when: '1m', status: 'ok' },
  { fn: 'now', ms: 68, when: '3m', status: 'ok' },
  { fn: 'alerts', ms: 0, when: '28m', status: 'error', note: 'upstream 503 · api.openweather.com' },
  { fn: 'historical', ms: 280, when: '1h', status: 'ok' },
];

function Field({ label, children }) {
  return <div style={{ marginBottom: 16 }}><W_lbl>{label}</W_lbl>{children}</div>;
}
function W_lbl({ children }) { return <div style={{ fontSize: 12.5, fontWeight: 600, color: AD.text, marginBottom: 6 }}>{children}</div>; }
function Input({ value, mono }) {
  return <div style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: `1px solid ${AD.border}`, borderRadius: 8, fontSize: 13, fontFamily: mono ? AD.mono : AD.font, color: AD.text, background: '#fff' }}>{value}</div>;
}

function VisCard({ id, label, desc, active, onClick }) {
  return (
    <button onClick={onClick} style={{ display: 'grid', gridTemplateColumns: '16px 1fr', gap: 11, alignItems: 'flex-start', textAlign: 'left', padding: '12px 13px', borderRadius: 10, cursor: 'pointer', fontFamily: AD.font, border: `1px solid ${active ? AD.text : AD.border}`, background: active ? AD.raised : '#fff', width: '100%', boxSizing: 'border-box' }}>
      <span style={{ marginTop: 1, width: 15, height: 15, borderRadius: 9999, border: `1.5px solid ${active ? AD.text : AD.borderStrong}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{active && <span style={{ width: 7, height: 7, borderRadius: 9999, background: AD.text }}/>}</span>
      <div><div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div><div style={{ fontSize: 11.5, color: AD.sec, marginTop: 2, lineHeight: 1.45 }}>{desc}</div></div>
    </button>
  );
}

function WidgetVisRow({ w }) {
  const [vis, setVis] = React.useState('public');
  const P = window.LaunchToolPage.Picker;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '12px 14px', border: `1px solid ${AD.border}`, borderRadius: 11 }}>
      <span style={{ width: 40, height: 40, borderRadius: 9, background: AD.raised, border: `1px solid ${AD.border}`, display: 'grid', placeItems: 'center', color: AD.mute }}><AC.IconGrid size={17}/></span>
      <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 13, fontWeight: 600 }}>{w.label} <A_Mono size={10.5} color={AD.mute}>{w.id}</A_Mono></div><div style={{ fontSize: 11.5, color: AD.sec, marginTop: 1 }}>{w.description}</div></div>
      <P value={vis} onChange={setVis} size="sm" minWidth={150} options={[{ id: 'public', label: 'Public' }, { id: 'unlisted', label: 'Unlisted' }, { id: 'private', label: 'Private' }]}/>
    </div>
  );
}

function AdminTab({ tab, vis = 'public', empty = false }) {
  if (tab === 'pricing') return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 64px', gap: 12, padding: '0 4px 8px', borderBottom: `1px solid ${AD.border}`, fontFamily: AD.mono, fontSize: 10, color: AD.mute, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        <span>Function</span><span style={{ textAlign: 'right' }}>Price / call</span><span style={{ textAlign: 'center' }}>p50</span>
      </div>
      {A_TOOL.functions.map((f) => (
        <div key={f.name} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 64px', gap: 12, alignItems: 'center', padding: '10px 4px', borderBottom: `1px solid ${AD.border}` }}>
          <span style={{ fontFamily: AD.mono, fontSize: 12.5 }}>{f.name}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}><span style={{ fontFamily: AD.mono, fontSize: 12, color: AD.mute }}>✦</span><div style={{ width: 72, textAlign: 'right', padding: '5px 8px', border: `1px solid ${AD.border}`, borderRadius: 6, fontFamily: AD.mono, fontSize: 12 }}>{f.price.toFixed(3)}</div></div>
          <A_Mono size={11} color={AD.mute} style={{ textAlign: 'center' }}>{f.p50}ms</A_Mono>
        </div>
      ))}
    </div>
  );
  if (tab === 'widgets') return (
    <div>
      <div style={{ marginBottom: 12 }}><W_lbl>Widget surfaces</W_lbl></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {A_TOOL.widgets.map((w) => <WidgetVisRow key={w.id} w={w}/>)}
      </div>
    </div>
  );
  if (tab === 'secrets') return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 12, color: AD.sec }}><A_Shield size={14}/>Secrets are encrypted and never leave the runtime — agents can’t read them.</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {SECRETS.map((s) => (
          <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 13px', border: `1px solid ${AD.border}`, borderRadius: 10 }}>
            <span style={{ color: AD.mute }}><A_Key size={15}/></span>
            <span style={{ flex: 1, fontFamily: AD.mono, fontSize: 12.5 }}>{s.key}</span>
            <A_Mono size={11} color={s.set ? AD.text : AD.mute}>{s.set ? '•••••••• set' : 'not set'}</A_Mono>
            <span style={{ fontSize: 12, color: AD.sec, cursor: 'pointer' }}>{s.set ? 'Rotate' : 'Add'}</span>
          </div>
        ))}
      </div>
    </div>
  );
  if (tab === 'trust') return (
    <div>
      <div style={{ marginBottom: 14 }}><A_Trust size={6} label="Signed manifest · receipts on"/></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 10, marginBottom: 18 }}>
        {[['Signer', A_TOOL.signer], ['Version', 'v' + A_TOOL.version], ['Runtime', 'deno'], ['Updated', A_TOOL.updatedAt + ' ago']].map(([k, v]) => (
          <div key={k} style={{ border: `1px solid ${AD.border}`, borderRadius: 10, padding: '11px 13px', background: AD.raised }}><A_Label mb={5}>{k}</A_Label><A_Mono size={13}>{v}</A_Mono></div>
        ))}
      </div>
      <W_lbl>Declared capabilities</W_lbl>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{A_TOOL.capabilities.map((c, i) => <A_Cap key={i} cap={c}/>)}</div>
    </div>
  );
  if (tab === 'receipts') {
    if (empty) return <EmptyBlock icon={<A_Copy size={26}/>} title="No receipts yet" body="Calls from agents will appear here with the Light each one earned."/>;
    return (
      <div>
        <div style={{ display: 'flex', gap: 14, marginBottom: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 160, border: `1px solid ${AD.border}`, borderRadius: 11, padding: '12px 14px', background: '#fff' }}><A_Label mb={4}>Revenue · 30d</A_Label><div style={{ fontFamily: AD.font, fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em', color: AD.text }}>✦297.6</div></div>
          <div style={{ flex: 1, minWidth: 160, border: `1px solid ${AD.border}`, borderRadius: 11, padding: '12px 14px', background: '#fff' }}><A_Label mb={4}>Calls · 30d</A_Label><div style={{ fontFamily: AD.font, fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em', color: AD.text }}>{aN(A_TOOL.callsPerDay * 30)}</div></div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 70px 50px 44px', gap: 12, padding: '8px 0', borderBottom: `1px solid ${AD.border}`, fontFamily: AD.mono, fontSize: 10, color: AD.mute, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          <span>Caller</span><span>Function</span><span style={{ textAlign: 'right' }}>Earned</span><span style={{ textAlign: 'right' }}>Status</span><span style={{ textAlign: 'right' }}>When</span>
        </div>
        {ADMIN_RECEIPTS.map((r, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 70px 50px 44px', gap: 12, alignItems: 'center', padding: '10px 0', borderBottom: `1px solid ${AD.border}`, fontSize: 12.5 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ width: 6, height: 6, borderRadius: 9999, background: r.status === 'error' ? AD.red : '#60a5fa' }}/>{r.caller}</span>
            <A_Mono size={11.5} color={AD.sec}>{r.fn}</A_Mono>
            <div style={{ fontFamily: AD.font, fontSize: 13, color: AD.text, textAlign: 'right' }}>✦{r.light.toFixed(3)}</div>
            <A_Mono size={11} color={r.status === 'error' ? AD.red : AD.sec} style={{ textAlign: 'right' }}>{r.status}</A_Mono>
            <A_Mono size={11} color={AD.mute} style={{ textAlign: 'right' }}>{r.when}</A_Mono>
          </div>
        ))}
      </div>
    );
  }
  if (tab === 'logs') {
    if (empty) return <EmptyBlock icon={<AC.IconTerminal size={26}/>} title="No runs yet" body="Recent calls and errors will stream here as agents use the tool."/>;
    return (
      <div>
        <W_lbl>Recent runs</W_lbl>
        {LOGS.map((l, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: `1px solid ${AD.border}`, fontSize: 12.5 }}>
            <span style={{ width: 7, height: 7, borderRadius: 9999, background: l.status === 'error' ? AD.red : AD.green, flexShrink: 0 }}/>
            <span style={{ fontFamily: AD.mono, fontSize: 12 }}>{l.fn}</span>
            {l.note && <span style={{ fontSize: 11.5, color: AD.red, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.note}</span>}
            <span style={{ flex: l.note ? 0 : 1 }}/>
            <A_Mono size={11} color={AD.sec}>{l.ms}ms</A_Mono>
            <A_Mono size={11} color={AD.mute}>{l.when}</A_Mono>
          </div>
        ))}
      </div>
    );
  }
  // edit (default)
  return (
    <div>
      <Field label="Name"><Input value={A_TOOL.name} mono/></Field>
      <Field label="Description"><div style={{ padding: '9px 12px', border: `1px solid ${AD.border}`, borderRadius: 8, fontSize: 13, color: AD.text, lineHeight: 1.5, minHeight: 52 }}>{A_TOOL.tagline}</div></Field>
      <div style={{ display: 'flex', gap: 14 }}>
        <div style={{ flex: 1 }}><Field label="Category"><Input value={A_TOOL.category}/></Field></div>
        <div style={{ flex: 1 }}><Field label="Tags"><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', paddingTop: 4 }}>{['weather', 'forecast', 'noaa'].map((t) => <span key={t} style={{ fontSize: 11.5, fontFamily: AD.mono, color: AD.sec, border: `1px solid ${AD.border}`, borderRadius: 6, padding: '4px 8px' }}>{t}</span>)}</div></Field></div>
      </div>
      <W_lbl>Visibility</W_lbl>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{VIS.map(([id, label, desc]) => <VisCard key={id} id={id} label={label} desc={desc} active={vis === id}/>)}</div>
    </div>
  );
}

function EmptyBlock({ icon, title, body }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 11, padding: '40px 20px', border: `1px dashed ${AD.borderStrong}`, borderRadius: 12, background: AD.raised, textAlign: 'center' }}>
      <span style={{ color: AD.mute }}>{icon}</span>
      <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 12.5, color: AD.sec, maxWidth: 340, lineHeight: 1.55 }}>{body}</div>
    </div>
  );
}

// ── Header ─────────────────────────────────────────────────────────────────────
function AdminHeader({ vis = 'public', suspended = false }) {
  return (
    <div style={{ marginBottom: 20 }}>
      {suspended && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '-28px 0 0', padding: '10px 13px', borderRadius: 9, background: AD.amberSoft, border: '1px solid rgba(245,158,11,0.3)', color: AD.amberDeep, fontSize: 12.5, fontWeight: 500 }}>
          <A_Shield size={14}/><span style={{ transform: 'translateY(1.5px)' }}>Hosting suspended — top up Light to resume serving calls. Public page shows “temporarily unavailable.”</span>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 13, margin: '12px 0 14px' }}>
        <A_Avatar name={A_TOOL.author} color={A_TOOL.authorColor} size={42}/>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-0.02em' }}>{A_TOOL.title || A_TOOL.name}</span>
          </div>
          <div style={{ fontSize: 12.5, color: AD.sec, marginTop: 3 }}>{aN(A_TOOL.installs)} installs · {aN(A_TOOL.callsPerDay)} calls/day</div>
        </div>
        <A_Btn kind="secondary" size="sm"><A_Ext size={13}/>View public page</A_Btn>
        <A_Btn kind="primary" size="sm">Save changes</A_Btn>
      </div>
    </div>
  );
}

function AdminDesktop({ tab = 'edit', vis = 'public', suspended = false, empty = false }) {
  return (
    <A_Browser url={`ultralight.dev/admin/tools/${A_TOOL.slug}${tab === 'edit' ? '' : '?tab=' + tab}`} width={1180} height={900}>
      <A_TopNav active="library" signedIn balance={12.40} cta={false}/>
      <A_Scroll>
        <div style={{ maxWidth: 880, margin: '0 auto', padding: '51px 32px 56px', fontFamily: AD.font }}>
          <AdminHeader vis={vis} suspended={suspended}/>
          <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${AD.border}`, marginBottom: 22, overflowX: 'auto' }}>
            {ATABS.map(([id, label]) => <span key={id} style={{ fontSize: 13, fontWeight: tab === id ? 600 : 500, color: tab === id ? AD.text : AD.mute, padding: '9px 11px', borderBottom: `2px solid ${tab === id ? AD.text : 'transparent'}`, marginBottom: -1, cursor: 'pointer', whiteSpace: 'nowrap' }}>{label}</span>)}
          </div>
          <AdminTab tab={tab} vis={vis} empty={empty}/>
        </div>
      </A_Scroll>
    </A_Browser>
  );
}

function AdminMobile({ tab = 'edit' }) {
  const [t, setT] = React.useState(tab);
  return (
    <A_Phone width={390} height={860}>
      <A_Bar signedIn title="Manage tool"/>
      <A_Scroll>
        <div style={{ padding: '16px 16px 40px', fontFamily: AD.font }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
            <A_Avatar name={A_TOOL.author} color={A_TOOL.authorColor} size={36}/>
            <div style={{ flex: 1 }}><div style={{ display: 'flex', alignItems: 'center', gap: 7 }}><span style={{ fontSize: 19, fontWeight: 500, letterSpacing: '-0.02em' }}>{A_TOOL.title || A_TOOL.name}</span></div></div>
          </div>
          <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${AD.border}`, marginBottom: 16, overflowX: 'auto' }}>
            {ATABS.map(([id, label]) => <button key={id} onClick={() => setT(id)} style={{ fontSize: 12.5, fontWeight: t === id ? 600 : 500, color: t === id ? AD.text : AD.mute, padding: '8px 9px', border: 'none', borderBottom: `2px solid ${t === id ? AD.text : 'transparent'}`, marginBottom: -1, background: 'transparent', cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit' }}>{label}</button>)}
          </div>
          <AdminTab tab={t} vis="public"/>
        </div>
      </A_Scroll>
      <div style={{ flexShrink: 0, padding: '10px 16px', borderTop: `1px solid ${AD.border}`, background: '#fff' }}><A_Btn kind="primary" size="lg" full>Save changes</A_Btn></div>
    </A_Phone>
  );
}

window.LaunchAdmin = { AdminDesktop, AdminMobile };
