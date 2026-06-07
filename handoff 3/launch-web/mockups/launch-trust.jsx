// launch-trust.jsx — "Trust & setup" card. Not a separate onboarding flow — a card
// that lives on tool pages, install, and widget-open states. Shows signed manifest,
// version, runtime, permissions, required setup/secrets, and receipts.
// Variants: ready · unsigned · setup · receipts · owner.

const { L: TR, CAP_COLORS: TR_CAP, CAP_GLYPH: TR_GLYPH } = window.LaunchData;
const TRC = window.LaunchChrome;
const { LMono: TR_Mono, LLabel: TR_Label, LBtn: TR_Btn } = window.LaunchChrome;
const TR_Shield = window.LaunchChrome.IconShield;

const PERMS_RW = [{ kind: 'read', what: 'public weather data' }, { kind: 'read', what: 'city / coordinates' }, { kind: 'net', what: 'api.openweather.com' }];
const PERMS_MAIL = [{ kind: 'read', what: 'your Gmail threads' }, { kind: 'write', what: 'send mail on your behalf' }, { kind: 'net', what: 'gmail.googleapis.com' }];

const TRUST_VARIANTS = {
  ready: { title: 'get_weather', signed: true, version: '2.4.1', runtime: 'deno · edge', receipts: true, perms: PERMS_RW, setup: [], owner: false, visibility: 'public' },
  unsigned: { title: 'legacy_scraper', signed: false, version: '0.3.0', runtime: 'deno', receipts: false, perms: [{ kind: 'net', what: 'unverified outbound HTTP' }], setup: [], owner: false, visibility: 'public', note: 'This manifest isn’t signed. Calls still run, but provenance isn’t verified — install with care.' },
  setup: { title: 'gmail.send', signed: true, version: '1.2.0', runtime: 'deno · edge', receipts: true, perms: PERMS_MAIL, setup: [{ label: 'Connect Gmail', kind: 'oauth', status: 'missing' }, { label: 'SENDER_NAME', kind: 'secret', status: 'set' }], owner: false, visibility: 'public' },
  receipts: { title: 'stripe.subscribe', signed: true, version: '3.1.0', runtime: 'deno · edge', receipts: true, perms: [{ kind: 'read', what: 'customer + price data' }, { kind: 'write', what: 'create subscriptions' }, { kind: 'net', what: 'api.stripe.com' }], setup: [{ label: 'STRIPE_SECRET_KEY', kind: 'secret', status: 'set' }], owner: false, visibility: 'public', emphasizeReceipts: true },
  owner: { title: 'get_weather', signed: true, version: '2.4.1', runtime: 'deno · edge', receipts: true, perms: PERMS_RW, setup: [], owner: true, visibility: 'private' },
};

function PermPill({ kind, what }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 9px', background: TR.raised, border: `1px solid ${TR.border}`, borderRadius: 7 }}>
      <TR_Mono size={10.5} color={TR_CAP[kind]} weight={600}>{TR_GLYPH[kind]} {kind}</TR_Mono>
      <span style={{ fontSize: 11.5, color: TR.sec, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{what}</span>
    </div>
  );
}

function MetaLine({ k, v, vColor }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '4px 0', fontSize: 12.5 }}><span style={{ color: TR.sec }}>{k}</span><TR_Mono size={12} color={vColor || TR.text}>{v}</TR_Mono></div>;
}

function TrustSetupCard({ variant = 'ready', data, style }) {
  const c = { ...TRUST_VARIANTS[variant], ...(data || {}) };
  const setupMissing = c.setup.some((s) => s.status === 'missing');
  return (
    <div style={{ border: `1px solid ${c.owner ? TR.borderStrong : TR.border}`, borderRadius: 12, overflow: 'hidden', background: '#fff', fontFamily: TR.font, ...style }}>
      <div style={{ padding: '13px 15px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
          <TR_Label mb={0}>Trust &amp; setup</TR_Label>
          {c.owner && <span style={{ fontFamily: TR.mono, fontSize: 9.5, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: TR.text, background: TR.active, borderRadius: 5, padding: '2px 6px' }}>You own this</span>}
        </div>

        {/* Signed status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
          {c.signed
            ? <React.Fragment><span style={{ display: 'inline-flex', gap: 3 }}>{[0, 1, 2].map((i) => <span key={i} style={{ width: 5, height: 5, borderRadius: 9999, background: '#16a34a' }}/>)}</span><span style={{ fontSize: 13, fontWeight: 600 }}>Signed manifest</span></React.Fragment>
            : <React.Fragment><span style={{ color: TR.amberDeep, display: 'inline-flex' }}><TR_Shield size={15}/></span><span style={{ fontSize: 13, fontWeight: 600, color: TR.amberDeep }}>Unsigned manifest</span></React.Fragment>}
        </div>
        {c.note && <div style={{ fontSize: 12, color: TR.sec, lineHeight: 1.5, marginBottom: 12, padding: '9px 11px', background: TR.amberSoft, border: '1px solid rgba(245,158,11,0.25)', borderRadius: 8 }}>{c.note}</div>}

        <MetaLine k="Version" v={`v${c.version}`}/>
        <MetaLine k="Runtime" v={c.runtime}/>
        <MetaLine k="Receipts" v={c.receipts ? 'on · every call logged' : 'off'} vColor={c.receipts ? TR.greenDeep : TR.mute}/>
        {c.owner && <MetaLine k="Visibility" v={c.visibility}/>}
      </div>

      {/* Permissions */}
      <div style={{ padding: '12px 15px', borderTop: `1px solid ${TR.border}` }}>
        <TR_Label mb={8}>Permissions</TR_Label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{c.perms.map((p, i) => <PermPill key={i} kind={p.kind} what={p.what}/>)}</div>
      </div>

      {/* Setup */}
      <div style={{ padding: '12px 15px', borderTop: `1px solid ${TR.border}`, background: setupMissing ? TR.amberSoft : TR.raised }}>
        <TR_Label mb={8}>Required setup</TR_Label>
        {c.setup.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: TR.greenDeep }}><span style={{ width: 14, height: 14, borderRadius: 9999, background: TR.greenSoft, display: 'grid', placeItems: 'center' }}><svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="#16a34a" strokeWidth="1.8" strokeLinecap="round"><path d="M2 5l2 2 4-4"/></svg></span>No setup required — ready to {c.owner ? 'serve' : 'call'}.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {c.setup.map((s, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span style={{ width: 7, height: 7, borderRadius: 9999, background: s.status === 'missing' ? TR.amber : TR.green, flexShrink: 0 }}/>
                <span style={{ flex: 1, fontSize: 12.5, color: TR.text }}>{s.label} <TR_Mono size={10} color={TR.mute}>{s.kind}</TR_Mono></span>
                <TR_Mono size={11} color={s.status === 'missing' ? TR.amberDeep : TR.greenDeep}>{s.status === 'missing' ? 'needed' : 'set'}</TR_Mono>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer action */}
      <div style={{ padding: '12px 15px', borderTop: `1px solid ${TR.border}` }}>
        {variant === 'setup' && <TR_Btn kind="primary" size="sm" full>Connect Gmail</TR_Btn>}
        {variant === 'unsigned' && <TR_Btn kind="secondary" size="sm" full>Install anyway</TR_Btn>}
        {variant === 'receipts' && <TR_Btn kind="secondary" size="sm" full>View receipts</TR_Btn>}
        {variant === 'owner' && <div style={{ display: 'flex', gap: 8 }}><TR_Btn kind="primary" size="sm" full>Manage</TR_Btn><TR_Btn kind="secondary" size="sm" full>Make public</TR_Btn></div>}
        {variant === 'ready' && <TR_Btn kind="secondary" size="sm" full>View manifest</TR_Btn>}
      </div>
    </div>
  );
}

// Gallery of all five variants (for the canvas section).
function TrustVariants() {
  const items = [['ready', 'Ready'], ['unsigned', 'Unsigned'], ['setup', 'Setup required'], ['receipts', 'Receipts enabled'], ['owner', 'Owner / private']];
  return (
    <div style={{ height: '100%', background: '#fbfbfa', padding: 22, fontFamily: TR.font, overflow: 'hidden' }}>
      <TR_Label mb={14}>Trust &amp; setup · variants</TR_Label>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {items.map(([v, label]) => (
          <div key={v} style={{ width: 300, flexShrink: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8, color: TR.text }}>{label} <TR_Mono size={10.5} color={TR.mute}>{v}</TR_Mono></div>
            <TrustSetupCard variant={v}/>
          </div>
        ))}
      </div>
    </div>
  );
}

window.LaunchTrust = { TrustSetupCard, TrustVariants };
