// launch-wallet.jsx — Wallet /wallet (desktop + mobile) + states.
// Backend: GET /api/launch/wallet → LaunchWalletSummary {
//   balance, spendableBalance, depositBalance, earnedBalance, escrowBalance (✦),
//   canTopUp, topUpUrl, transactionsUrl, receiptsUrl, earningsUrl, payoutsUrl,
//   payoutStatus: { kind, label, description, actionUrl } }.
// Top-up economics lifted from premium_ui/add-light-flows.jsx (rates 100/99/95 ✦/$).

const { L: W } = window.LaunchData;
const WC = window.LaunchChrome;
const {
  LMono: W_Mono, LLabel: W_Label, LBtn: W_Btn, LAvatar: W_Avatar,
  LTopNav: W_TopNav, LMobileBar: W_Bar, BrowserFrame: W_Browser, PhoneFrame: W_Phone, LScroll: W_Scroll,
  IconCopy: W_Copy, IconShield: W_Shield, IconExternal: W_Ext,
} = window.LaunchChrome;

const WALLET = {
  spendable: 12.402, deposit: 8.150, earned: 4820.402, escrow: 0.260,
};
const RATES = { wallet: 95, wire: 99, transfer: 100 };
// Balance ledger — spend, top-ups, transfers, payouts (NOT earnings).
const LEDGER = [
  { kind: 'call', detail: 'get_weather · forecast', when: '2m', amt: -0.012 },
  { kind: 'call', detail: 'currency_convert · convert', when: '14m', amt: -0.002 },
  { kind: 'topup', detail: 'Top up · Apple Pay', when: '3h', amt: +47.5 },
  { kind: 'call', detail: 'pdf.parse · extract', when: '6h', amt: -0.018 },
  { kind: 'transfer', detail: 'Earnings → Balance', when: '1d', amt: +25.0 },
  { kind: 'call', detail: 'maps.route · route', when: '1d', amt: -0.008 },
  { kind: 'payout', detail: 'Payout · ACH ···4821', when: '4d', amt: -500.0 },
  { kind: 'topup', detail: 'Top up · Bank wire', when: '1w', amt: +200.0 },
  { kind: 'call', detail: 'get_weather · alerts', when: '1w', amt: -0.004 },
  { kind: 'call', detail: 'currency_convert · historical', when: '2w', amt: -0.003 },
];
// Earnings ledger — creator income, filterable by tool.
const EARNINGS = [
  { kind: 'earning', detail: 'get_weather · forecast', tool: 'get_weather', when: '5h', amt: +2.480 },
  { kind: 'earning', detail: 'tweet.draft · compose', tool: 'tweet.draft', when: '8h', amt: +1.204 },
  { kind: 'earning', detail: 'radar.tile · render', tool: 'radar.tile', when: '1d', amt: +0.400 },
  { kind: 'earning', detail: 'get_weather · now', tool: 'get_weather', when: '1d', amt: +1.920 },
  { kind: 'earning', detail: 'radar.tile · render', tool: 'radar.tile', when: '3d', amt: +0.400 },
  { kind: 'earning', detail: 'tweet.draft · compose', tool: 'tweet.draft', when: '4d', amt: +1.204 },
];
function InfiniteFooter() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, padding: '18px 0 4px', borderTop: `1px solid ${W.border}` }}>
      <span style={{ width: 14, height: 14, border: `2px solid ${W.border}`, borderTopColor: W.sec, borderRadius: 9999, display: 'inline-block', animation: 'pui-spin 0.7s linear infinite' }}/>
      <span style={{ fontSize: 12, color: W.mute }}>Loading more…</span>
    </div>
  );
}
const RECEIPTS = [
  { tool: 'get_weather', fn: 'forecast', light: 0.012, tokens: 0, latency: 142, when: '2m', status: 'ok' },
  { tool: 'currency_convert', fn: 'convert', light: 0.002, tokens: 0, latency: 84, when: '14m', status: 'ok' },
  { tool: 'pdf.parse', fn: 'extract', light: 0.018, tokens: 0, latency: 480, when: '1d', status: 'ok' },
  { tool: 'maps.route', fn: 'route', light: 0.008, tokens: 0, latency: 195, when: '2d', status: 'error' },
];
const EARN_BY_TOOL = [
  { tool: 'get_weather', calls: 268000, light: 3216.0 },
  { tool: 'tweet.draft', calls: 41000, light: 1204.4 },
  { tool: 'radar.tile', calls: 88000, light: 400.0 },
];
const PAYOUT_STATES = {
  not_connected: { kind: 'not_connected', label: 'Payouts not connected', description: 'Earnings accrue as Light. Connect a payout account to withdraw to a bank.', action: 'Connect payouts', tone: 'neutral' },
  onboarding: { kind: 'onboarding', label: 'Payout setup incomplete', description: 'Finish Stripe onboarding before requesting bank payouts.', action: 'Resume Stripe onboarding', tone: 'amber' },
  ready: { kind: 'ready', label: 'Payouts ready', description: 'Stripe Connect payouts are enabled. Withdraw earned Light to your bank.', action: 'Withdraw earnings', tone: 'green' },
};

const WTABS = [['balance', 'Balance'], ['topup', 'Top up'], ['earnings', 'Earnings']];

// ── Wallet hero (serif label + ✦ amount) ─────────────────────────────────────
function WalletHero({ label, value, big = true }) {
  const [whole, frac] = value.toFixed(3).split('.');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {label && <span style={{ fontFamily: W.font, fontSize: big ? 15 : 14, fontWeight: 500, color: W.sec, letterSpacing: '-0.005em' }}>{label}</span>}
      <span style={{ fontVariantNumeric: 'tabular-nums', display: 'inline-flex', alignItems: 'baseline', gap: 2 }}>
        <span style={{ fontSize: big ? 26 : 22, fontWeight: 500, color: W.text, marginRight: 3 }}>✦</span>
        <span style={{ fontSize: big ? 42 : 32, fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1 }}>{Number(whole).toLocaleString()}</span>
        <span style={{ fontSize: big ? 20 : 16, color: W.mute, fontWeight: 500 }}>.{frac}</span>
      </span>
    </div>
  );
}
function MiniMetric({ label, v, sub }) {
  return (
    <div style={{ flex: 1, border: `1px solid ${W.border}`, borderRadius: 10, background: W.raised, padding: '11px 13px' }}>
      <W_Label mb={5}>{label}</W_Label>
      <W_Mono size={15}>✦{v}</W_Mono>
      {sub && <div style={{ fontSize: 11, color: W.mute, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

// ── Payout status banner ────────────────────────────────────────────────────────
function PayoutBanner({ st }) {
  const tone = st.tone === 'green' ? { bg: W.greenSoft, bd: 'rgba(34,197,94,0.3)', fg: W.greenDeep }
    : st.tone === 'amber' ? { bg: W.amberSoft, bd: 'rgba(245,158,11,0.3)', fg: W.amberDeep }
    : { bg: W.raised, bd: W.border, fg: W.sec };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '13px 15px', borderRadius: 11, background: tone.bg, border: `1px solid ${tone.bd}` }}>
      <span style={{ width: 34, height: 34, borderRadius: 9, background: '#fff', border: `1px solid ${W.border}`, display: 'grid', placeItems: 'center', color: tone.fg }}><W_Shield size={17}/></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{st.label}</div>
        <div style={{ fontSize: 12, color: W.sec, marginTop: 1, lineHeight: 1.45 }}>{st.description}</div>
      </div>
      <W_Btn kind={st.tone === 'neutral' ? 'secondary' : 'primary'} size="sm">{st.action}</W_Btn>
    </div>
  );
}

// ── Ledger row ───────────────────────────────────────────────────────────────
function TxRow({ t, first }) {
  const pos = t.amt > 0;
  const glyph = { call: '→', topup: '+', earning: '✦', transfer: '⇄', payout: '↑' }[t.kind];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '28px 1fr auto auto', gap: 12, alignItems: 'center', padding: '11px 0', borderTop: first ? 'none' : `1px solid ${W.border}` }}>
      <span style={{ width: 24, height: 24, display: 'grid', placeItems: 'center', fontFamily: W.mono, fontSize: 13, color: W.sec }}>{glyph}</span>
      <span style={{ fontSize: 13, color: W.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.detail}</span>
      <W_Mono size={11} color={W.mute}>{t.when}</W_Mono>
      <W_Mono size={12.5} color={pos ? W.greenDeep : W.text} style={{ textAlign: 'right', minWidth: 78 }}>✦{Math.abs(t.amt).toFixed(3)}</W_Mono>
    </div>
  );
}

// ── Receipt row ──────────────────────────────────────────────────────────────
function ReceiptRow({ r }) {
  const dot = r.status === 'error' ? W.red : '#60a5fa';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 64px 60px 44px', gap: 12, alignItems: 'center', padding: '10px 0', borderTop: `1px solid ${W.border}`, fontSize: 12.5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span style={{ width: 6, height: 6, borderRadius: 9999, background: dot, flexShrink: 0 }}/>
        <span style={{ fontFamily: W.mono, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.tool}<span style={{ color: W.mute }}>·{r.fn}</span></span>
      </div>
      <W_Mono size={12} style={{ textAlign: 'right' }}>{r.light > 0 ? `✦${r.light.toFixed(3)}` : '—'}</W_Mono>
      <W_Mono size={11} color={W.sec} style={{ textAlign: 'right' }}>{r.latency}ms</W_Mono>
      <W_Mono size={11} color={r.status === 'error' ? W.red : W.greenDeep} style={{ textAlign: 'right' }}>{r.status}</W_Mono>
      <W_Mono size={11} color={W.mute} style={{ textAlign: 'right' }}>{r.when}</W_Mono>
    </div>
  );
}

// ── Top-up flow (compact, web) ──────────────────────────────────────────────────
function GPayMark({ size = 17 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" style={{ display: 'block' }} aria-hidden="true">
      <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/>
      <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>
      <path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"/>
      <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/>
    </svg>
  );
}
function TopUp() {
  const [method, setMethod] = React.useState('wallet');
  const [usd, setUsd] = React.useState(50);
  const [light, setLight] = React.useState(1000);
  const isTransfer = method === 'transfer';
  const maxLight = Math.floor(WALLET.earned);
  const received = isTransfer ? light : usd * 100;
  const fee = isTransfer ? 0 : (method === 'wire' ? Math.min(usd * 0.008, 5) : usd * 0.029 + 0.30);
  const feeLabel = method === 'wire' ? '0.8% · max $5' : '2.9% + $0.30';
  const total = usd + fee;
  const purchasePresets = [10, 25, 50, 100, 500];
  const transferPresets = [1000, 2500, 10000, 25000, 'max'];
  const payFont = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 36, alignItems: 'start', paddingTop: 11 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 49, padding: '0 14px', boxSizing: 'border-box', border: `1px solid ${W.borderStrong}`, borderRadius: 10, marginBottom: 10 }}>
          <span style={{ fontSize: 22, lineHeight: 1, fontWeight: 600, color: W.text, transform: 'translateY(2.5px)' }}>{isTransfer ? '✦' : '$'}</span>
          <span style={{ flex: 1, fontFamily: W.font, fontSize: 22, lineHeight: 1, fontWeight: 600, fontVariantNumeric: 'tabular-nums', transform: 'translateY(2.5px)' }}>{isTransfer ? light.toLocaleString() : usd}</span>
          <span style={{ fontFamily: W.font, fontSize: 12, fontWeight: 500, color: W.mute, transform: 'translateY(1px)' }}>{isTransfer ? 'Light' : 'USD'}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap' }}>
          {(isTransfer ? transferPresets : purchasePresets).map((v) => {
            const sel = isTransfer ? (v === 'max' ? light === maxLight : light === v) : usd === v;
            const label = isTransfer ? (v === 'max' ? 'Max' : v.toLocaleString()) : `$${v}`;
            return <button key={v} onClick={() => isTransfer ? setLight(v === 'max' ? maxLight : v) : setUsd(v)} style={{ fontFamily: W.font, fontSize: 13, fontWeight: 500, padding: '6px 13px 5px', borderRadius: 9999, cursor: 'pointer', border: `1px solid ${sel ? W.text : W.border}`, background: sel ? W.text : '#fff', color: sel ? '#fff' : W.sec }}>{label}</button>;
          })}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {[['wallet', 'Apple Pay / Google Pay'], ['wire', 'Bank wire (ACH)'], ['transfer', 'Transfer from Earnings']].map(([id, name]) => (
            <button key={id} onClick={() => setMethod(id)} style={{ display: 'block', textAlign: 'left', padding: '13px 14px', borderRadius: 10, cursor: 'pointer', fontFamily: W.font, border: `1px solid ${method === id ? W.text : W.border}`, background: '#fff' }}>
              <div style={{ fontSize: 13.5, fontWeight: 500, transform: 'translateY(1px)' }}>{name}</div>
            </button>
          ))}
        </div>
      </div>
      <div style={{ background: W.raised, border: `1px solid ${W.border}`, borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column' }}>
        <W_Label mb={12}>{isTransfer ? 'Transfer summary' : 'Order summary'}</W_Label>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 9 }}><span style={{ color: W.sec }}>{isTransfer ? 'From Earnings' : 'You pay'}</span><span style={{ fontFamily: W.font, fontWeight: 600, fontVariantNumeric: 'tabular-nums', transform: 'translateY(1px)' }}>{isTransfer ? `✦${light.toLocaleString()}` : `$${usd.toFixed(2)}`}</span></div>
        {!isTransfer && <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 9 }}><span style={{ color: W.sec }}>Processing fee <span style={{ color: W.mute }}>· {feeLabel}</span></span><span style={{ fontFamily: W.font, fontVariantNumeric: 'tabular-nums', color: W.sec, transform: 'translateY(1px)' }}>${fee.toFixed(2)}</span></div>}
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 12 }}><span style={{ color: W.sec }}>Rate</span><span style={{ fontFamily: W.font, color: W.sec, fontVariantNumeric: 'tabular-nums', transform: 'translateY(1px)' }}>{isTransfer ? '1:1 · no fee' : '✦100 / $1'}</span></div>
        <div style={{ height: 1, background: W.border, margin: '4px 0 14px' }}/>
        {!isTransfer && <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 12 }}><span style={{ fontWeight: 600 }}>Total</span><span style={{ fontFamily: W.font, fontWeight: 600, fontVariantNumeric: 'tabular-nums', transform: 'translateY(1px)' }}>${total.toFixed(2)}</span></div>}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 13.5, fontWeight: 700 }}>You receive</span>
          <span style={{ fontFamily: W.font, fontVariantNumeric: 'tabular-nums', display: 'inline-flex', alignItems: 'baseline', gap: 3, transform: 'translateY(1px)' }}><span style={{ fontSize: 16 }}>✦</span><span style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em' }}>{received.toLocaleString()}</span></span>
        </div>
        {method === 'wallet' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 18 }}>
            <button style={{ height: 46, borderRadius: 9, border: 'none', background: '#000', color: '#fff', fontFamily: payFont, fontSize: 18, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, cursor: 'pointer' }}><span style={{ fontSize: 18, transform: 'translateY(-1px)' }}></span>Pay</button>
            <button style={{ height: 46, borderRadius: 9, border: `1px solid ${W.borderStrong}`, background: '#fff', color: '#3c4043', fontFamily: payFont, fontSize: 17, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, cursor: 'pointer' }}><GPayMark/>Pay</button>
          </div>
        ) : (
          <W_Btn kind="primary" size="lg" full style={{ marginTop: 18 }}>{isTransfer ? `Transfer ✦${light.toLocaleString()}` : `Pay $${total.toFixed(2)}`}</W_Btn>
        )}
        <div style={{ marginTop: 12, fontFamily: W.font, fontSize: 12, color: W.mute, display: 'flex', alignItems: 'center', gap: 6 }}><W_Shield size={12}/><span style={{ transform: 'translateY(1px)' }}>{isTransfer ? 'Instant internal transfer' : 'Secure checkout · Stripe'}</span></div>
      </div>
    </div>
  );
}

// ── Tab content ─────────────────────────────────────────────────────────────────
const WALLET_EARN_TOOLS = ['all', 'get_weather', 'tweet.draft', 'radar.tile'];
function EarningsPanel({ filter = 'all' }) {
  const rows = EARNINGS.filter((e) => filter === 'all' || e.tool === filter);
  return (
    <div>
      {rows.map((e, i) => <TxRow key={i} t={e} first={i === 0}/>)}
      <InfiniteFooter/>
    </div>
  );
}

// Tab bar where the active Earnings tab doubles as a ▾ tool-filter dropdown
// (mirrors the Functions / Widgets tab dropdowns on the public tool page).
function WalletTabBar({ tab, onTab, filter, onFilter, mobile = false }) {
  const [open, setOpen] = React.useState(false);
  const fs = mobile ? 12.5 : 13;
  const pad = mobile ? '8px 9px' : '9px 11px';
  return (
    <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${W.border}`, marginBottom: mobile ? 16 : 22, position: 'relative' }}>
      {WTABS.map(([id, label]) => {
        const active = tab === id;
        if (id !== 'earnings') {
          return (
            <span key={id} onClick={() => onTab(id)} style={{ fontSize: fs, fontWeight: active ? 600 : 500, color: active ? W.text : W.mute, padding: pad, borderBottom: `2px solid ${active ? W.text : 'transparent'}`, marginBottom: -1, cursor: 'pointer', whiteSpace: 'nowrap' }}>{label}</span>
          );
        }
        return (
          <span key={id} style={{ position: 'relative', display: 'inline-flex' }}>
            <span onClick={() => { if (!active) { onTab('earnings'); setOpen(true); } else setOpen((o) => !o); }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: fs, fontWeight: active ? 600 : 500, color: active ? W.text : W.mute, padding: pad, borderBottom: `2px solid ${active ? W.text : 'transparent'}`, marginBottom: -1, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              <span>{label}</span>
              <span style={{ fontSize: 9, color: active ? W.sec : W.mute, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 140ms' }}>▾</span>
            </span>
            {open && active && (
              <React.Fragment>
                <span onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }}/>
                <div style={{ position: 'absolute', top: 'calc(100% + 8px)', left: 0, minWidth: 200, zIndex: 41, background: '#fff', border: `1px solid ${W.border}`, borderRadius: 12, boxShadow: '0 14px 38px rgba(0,0,0,0.14)', padding: 5 }}>
                  {WALLET_EARN_TOOLS.map((t) => (
                    <button key={t} onClick={() => { onFilter(t); setOpen(false); }} style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 9, fontFamily: W.font, fontSize: 13.5, fontWeight: t === filter ? 600 : 500, color: W.text, padding: '8px 10px', border: 'none', borderRadius: 8, background: t === filter ? W.raised : 'transparent', cursor: 'pointer' }}>
                      <span style={{ width: 13, display: 'inline-flex', justifyContent: 'center', color: W.text }}>{t === filter ? '✓' : ''}</span>
                      <span style={{ fontFamily: W.font }}>{t === 'all' ? 'All tools' : t}</span>
                    </button>
                  ))}
                </div>
              </React.Fragment>
            )}
          </span>
        );
      })}
    </div>
  );
}
function TabPanel({ tab, filter = 'all', payout = 'ready' }) {
  if (tab === 'topup') return <TopUp/>;
  if (tab === 'earnings') return <EarningsPanel filter={filter}/>;
  // balance (default) — combined transaction ledger w/ infinite scroll
  return (
    <div>
      {LEDGER.map((t, i) => <TxRow key={i} t={t} first={i === 0}/>)}
      <InfiniteFooter/>
    </div>
  );
}

// ── Desktop ───────────────────────────────────────────────────────────────────
function WalletDesktop({ tab = 'balance', payout = 'ready' }) {
  const [t, setT] = React.useState(tab);
  const [filter, setFilter] = React.useState('all');
  return (
    <W_Browser url={`ultralight.dev/wallet${t === 'balance' ? '' : '?tab=' + t}`} width={1180} height={900}>
      <W_TopNav active="wallet" signedIn balance={WALLET.spendable} cta={false} showBalance={false}/>
      <W_Scroll>
        <div style={{ maxWidth: 860, margin: '0 auto', padding: '51px 32px 56px', fontFamily: W.font }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, marginBottom: 22 }}>
            {t === 'earnings'
              ? <WalletHero value={WALLET.earned}/>
              : <WalletHero value={WALLET.spendable}/>}
            <div style={{ display: 'flex', gap: 8 }}>
              {t === 'earnings'
                ? <React.Fragment><W_Btn kind="secondary">Withdraw</W_Btn><W_Btn kind="primary">Transfer to Balance</W_Btn></React.Fragment>
                : t === 'topup'
                ? null
                : <W_Btn kind="primary">+ Add Light</W_Btn>}
            </div>
          </div>
          <WalletTabBar tab={t} onTab={setT} filter={filter} onFilter={setFilter}/>
          <TabPanel tab={t} filter={filter} payout={payout}/>
        </div>
      </W_Scroll>
    </W_Browser>
  );
}

// ── Mobile ───────────────────────────────────────────────────────────────────
function WalletMobile({ tab = 'balance' }) {
  const [t, setT] = React.useState(tab);
  const [filter, setFilter] = React.useState('all');
  return (
    <W_Phone width={390} height={860}>
      <W_Bar signedIn balance={WALLET.spendable} title="Wallet"/>
      <W_Scroll>
        <div style={{ padding: '18px 16px 40px', fontFamily: W.font }}>
          <div style={{ border: `1px solid ${W.border}`, borderRadius: 12, padding: '16px 16px', marginBottom: 16, background: W.raised }}>
            {t === 'earnings'
              ? <WalletHero value={WALLET.earned} big={false}/>
              : <WalletHero value={WALLET.spendable} big={false}/>}
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              {t === 'earnings'
                ? <React.Fragment><W_Btn kind="primary" size="md" full>Transfer to Balance</W_Btn><W_Btn kind="secondary" size="md" full>Withdraw</W_Btn></React.Fragment>
                : t === 'topup'
                ? null
                : <W_Btn kind="primary" size="md" full>+ Add Light</W_Btn>}
            </div>
          </div>
          <WalletTabBar tab={t} onTab={setT} filter={filter} onFilter={setFilter} mobile/>
          <TabPanel tab={t} filter={filter} payout="ready"/>
        </div>
      </W_Scroll>
    </W_Phone>
  );
}

// ── States ──────────────────────────────────────────────────────────────────
function WalletState({ which }) {
  const { StateFrame } = window.LaunchToolPageMobile;
  if (which === 'zero') {
    return (
      <StateFrame url="ultralight.dev/wallet" label="Empty · new account" signedIn>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '34px 32px' }}>
          <div style={{ fontSize: 38, fontWeight: 700, letterSpacing: '-0.03em', color: W.mute, marginBottom: 22 }}>✦0.000</div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '36px 20px', border: `1px dashed ${W.borderStrong}`, borderRadius: 12, background: W.raised, textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Add Light to start calling tools</div>
            <div style={{ fontSize: 12.5, color: W.sec, maxWidth: 360, lineHeight: 1.55 }}>Installing is free — Light is metered per call. Top up with Apple/Google Pay or a bank wire.</div>
            <W_Btn kind="primary" style={{ marginTop: 4 }}>+ Add Light</W_Btn>
          </div>
        </div>
      </StateFrame>
    );
  }
  // payout state machine trio
  return (
    <StateFrame url="ultralight.dev/wallet?tab=payouts" label="Payout status · state machine" signedIn>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '30px 32px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <W_Label mb={2}>LaunchPayoutStatus.kind</W_Label>
        <PayoutBanner st={PAYOUT_STATES.not_connected}/>
        <PayoutBanner st={PAYOUT_STATES.onboarding}/>
        <PayoutBanner st={PAYOUT_STATES.ready}/>
      </div>
    </StateFrame>
  );
}

window.LaunchWallet = { WalletDesktop, WalletMobile, WalletState };
