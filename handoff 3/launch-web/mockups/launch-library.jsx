// launch-library.jsx — Library /library (desktop + mobile) + empty states.
// Signed-in. Backend: GET /api/launch/library → LaunchLibraryResponse {
//   owned: LaunchToolSummary[], installed: LaunchToolSummary[] }.

const { L: LB, DISCOVER_TOOLS: LB_TOOLS, TOOL_WEATHER: LB_OWNED, fmtN: lbN } = window.LaunchData;
const LBC = window.LaunchChrome;
const {
  LMono: LB_Mono, LLabel: LB_Label, LBtn: LB_Btn, LAvatar: LB_Avatar,
  LTopNav: LB_TopNav, LMobileBar: LB_Bar, BrowserFrame: LB_Browser, PhoneFrame: LB_Phone, LScroll: LB_Scroll,
  IconExternal: LB_Ext, IconGrid: LB_GridI,
} = window.LaunchChrome;

const INSTALLED = LB_TOOLS.filter((t) => ['currency_convert', 'pdf_parse', 'maps_route', 'github_diff'].includes(t.slug));

// Owned tool card — cleaned: no kind / visibility badges, no price.
function OwnedCard({ t, mobile }) {
  return (
    <div style={{ border: `1px solid ${LB.border}`, borderRadius: 12, background: '#fff', overflow: 'hidden' }}>
      <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <LB_Avatar name={t.author} color={t.authorColor} size={34}/>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 500, letterSpacing: '-0.01em' }}>{t.title || t.name}</div>
          <div style={{ fontSize: 12, color: LB.sec, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.tagline}</div>
        </div>
      </div>
      <div style={{ display: 'flex', borderTop: `1px solid ${LB.border}`, background: LB.raised }}>
        {[['Installs', lbN(t.installs)], ['Calls/day', lbN(t.callsPerDay)], ['Earned 30d', '✦297.6']].map(([k, v], i) => (
          <div key={k} style={{ flex: 1, padding: '10px 14px', borderRight: i < 2 ? `1px solid ${LB.border}` : 'none' }}>
            <LB_Label mb={3}>{k}</LB_Label><LB_Mono size={13}>{v}</LB_Mono>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '12px 16px', borderTop: `1px solid ${LB.border}` }}>
        <LB_Btn kind="primary" size="sm">Manage</LB_Btn>
        <LB_Btn kind="secondary" size="sm"><LB_Ext size={13}/>Public page</LB_Btn>
        {t.widgets.length > 0 && <LB_Btn kind="ghost" size="sm"><LB_GridI size={13}/>{t.widgets.length} widgets</LB_Btn>}
      </div>
    </div>
  );
}

function LibraryBody({ mobile, empty }) {
  const Picker = window.LaunchToolPage.Picker;
  const ToolCard = window.LaunchDiscover.ToolCard;
  const [view, setView] = React.useState('installed');

  if (empty) {
    return (
      <div style={{ maxWidth: 760, margin: '0 auto', padding: mobile ? '10px 16px 40px' : '51px 32px 56px', fontFamily: LB.font }}>
        {[['Tools you own', 'Ship your first tool from the CLI — it shows up here with installs, calls, and earnings.', 'Deploy docs'], ['Installed', 'Tools you install from the Store appear here, ready to configure and call.', 'Browse the Store']].map(([t, d, a], i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 11, padding: '34px 20px', border: `1px dashed ${LB.borderStrong}`, borderRadius: 12, background: LB.raised, textAlign: 'center', marginBottom: 14 }}>
            <div style={{ fontSize: 16, fontWeight: 500 }}>{t} — nothing yet</div>
            <div style={{ fontSize: 12.5, color: LB.sec, maxWidth: 340, lineHeight: 1.55 }}>{d}</div>
            <LB_Btn kind={i === 0 ? 'primary' : 'secondary'} size="sm" style={{ marginTop: 2 }}>{a}</LB_Btn>
          </div>
        ))}
      </div>
    );
  }

  const count = view === 'installed' ? INSTALLED.length : 1;
  return (
    <div style={{ maxWidth: 880, margin: '0 auto', padding: mobile ? '10px 16px 40px' : '51px 32px 56px', fontFamily: LB.font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <Picker value={view} onChange={setView} size="sm" minWidth={188}
          options={[{ id: 'installed', label: 'Installed tools' }, { id: 'owned', label: 'Tools you own' }]}/>
        <span style={{ fontFamily: LB.font, fontSize: 14, color: LB.mute }}>{count}</span>
      </div>

      {view === 'installed' && (
        <div style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr' : 'repeat(2, 1fr)', gap: 12 }}>
          {INSTALLED.map((t) => <ToolCard key={t.id} tool={t}/>)}
        </div>
      )}
      {view === 'owned' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <OwnedCard t={LB_OWNED} mobile={mobile}/>
        </div>
      )}
    </div>
  );
}

function LibraryDesktop({ empty = false }) {
  return (
    <LB_Browser url="ultralight.dev/library" width={1180} height={860}>
      <LB_TopNav active="library" signedIn balance={12.40} cta={!empty}/>
      <LB_Scroll><LibraryBody empty={empty}/></LB_Scroll>
    </LB_Browser>
  );
}
function LibraryMobile({ empty = false }) {
  return (
    <LB_Phone width={390} height={860}>
      <LB_Bar signedIn balance={12.40} title="Library" cta={!empty}/>
      <LB_Scroll><LibraryBody mobile empty={empty}/></LB_Scroll>
    </LB_Phone>
  );
}

window.LaunchLibrary = { LibraryDesktop, LibraryMobile };
