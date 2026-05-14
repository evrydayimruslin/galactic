// ProfileView — native profile / wallet surface.
//
// Replaces the embedded WebPanel /my-profile iframe (and absorbs the
// kind: 'wallet' route per the design's refined 3A: balance lives inside
// profile under the BALANCE tab; there is no separate wallet page).
//
// Layout per handoff/mockups/profile-screens.jsx ProfileStatement + the
// design's "3A refined" screenshot:
//   - Identity strip: avatar + display name + sub-line ("active since X ·
//     N published · M acquired") · tabs top-right (BALANCE / EARNINGS /
//     SETTINGS — no Activity, no Edit Profile, per refinement notes)
//   - BALANCE tab: hero (✦ balance + Add Light) | 7-day bar chart with
//     daily totals · recent activity table (DATE / TIME / SOURCE / MEMO
//     / AMOUNT)
//   - EARNINGS tab: 4-stat grid + bank-payouts CTA + published-tools
//     list. Full payout / Connect-onboard flow lands in Batch 5c.
//   - SETTINGS tab: stub for 5c (API key, BYOK, billing address).
//
// Add Light button is wired to a no-op until Batch 5b ships the modal.
// onOpenAddLight prop lets App.tsx provide the real handler when ready.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchUserProfile,
  fetchUserHosting,
  fetchUserTransactions,
  fetchUserEarnings,
  fetchConnectStatus,
  fetchPayoutHistory,
  fetchBillingAddress,
  startConnectOnboard,
  toggleAutoAddEarnings,
  updateUserProfile,
  updateBillingAddress,
  type UserProfile,
  type UserHosting,
  type BillingTransaction,
  type UserEarnings,
  type ConnectStatus,
  type PayoutRow,
  type BillingAddress,
} from '../lib/api';
import AddLightModal from './profile/AddLightModal';
import WithdrawModal from './profile/WithdrawModal';

// Open an external URL. Tauri's webview routes target=_blank through the
// host's default browser, so this works without the shell plugin (which
// would be a new dependency).
function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

type ProfileViewProps = Record<string, never>;

type Tab = 'balance' | 'earnings' | 'settings';

// ── Helpers ──────────────────────────────────────────────────────────

function formatLight(n: number | undefined | null, decimals = 3): string {
  if (n === undefined || n === null) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000 && decimals === 0) return `${(n / 1_000).toFixed(1)}k`;
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toFixed(decimals);
}

function splitLightForHero(n: number | undefined): { whole: string; fraction: string } {
  if (n === undefined || n === null) return { whole: '—', fraction: '' };
  // Style spec: big "798" + smaller ",032" tail (3-digit thousands tail).
  const rounded = Math.round(n);
  const s = rounded.toLocaleString();
  const parts = s.split(',');
  if (parts.length <= 1) return { whole: s, fraction: '' };
  return { whole: parts[0], fraction: ',' + parts.slice(1).join(',') };
}

function formatTimeOfDay(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

function dateBucket(iso: string | undefined): string {
  if (!iso) return 'UNKNOWN';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return 'UNKNOWN';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dCopy = new Date(d);
  dCopy.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - dCopy.getTime()) / 86_400_000);
  if (diffDays === 0) return 'TODAY';
  if (diffDays === 1) return 'YESTERDAY';
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase();
}

function humanizeCategory(category: string | undefined): string {
  if (!category) return '—';
  switch (category) {
    case 'storage_at_rest': return 'storage';
    case 'chat_inference': return 'chat';
    case 'tool_call': return 'tool call';
    case 'marketplace_sale': return 'marketplace';
    case 'marketplace_bid': return 'bid escrow';
    case 'deposit': return 'wallet';
    case 'auto_topup': return 'wallet';
    case 'tool_earnings': return 'tool earnings';
    case 'payout': return 'payout';
    default: return category.replace(/_/g, ' ');
  }
}

function bucketDailySums(transactions: BillingTransaction[]): { dailyTotals: number[]; labels: string[] } {
  // Today and 6 prior days. Each day's total is the absolute sum of
  // amount_light debits + credits. Positive = credit, negative = debit; here
  // we want gross "money moved" per day so we use abs.
  const days: { date: Date; total: number }[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    days.push({ date: d, total: 0 });
  }
  for (const tx of transactions) {
    if (!tx.created_at || tx.amount_light === undefined) continue;
    const d = new Date(tx.created_at);
    if (!Number.isFinite(d.getTime())) continue;
    d.setHours(0, 0, 0, 0);
    const day = days.find((x) => x.date.getTime() === d.getTime());
    if (!day) continue;
    day.total += Math.abs(tx.amount_light);
  }
  return {
    dailyTotals: days.map((d) => d.total),
    labels: days.map((d) => d.date.toLocaleDateString(undefined, { weekday: 'narrow' })),
  };
}

// ── Bar chart ────────────────────────────────────────────────────────

function SevenDayBars({ totals, labels }: { totals: number[]; labels: string[] }) {
  const max = Math.max(...totals, 0.001);
  return (
    <div>
      <div className="text-nano font-mono text-ul-text-muted uppercase tracking-widest mb-2">
        Last 7 days
      </div>
      <div className="flex items-end gap-2 h-[100px] mb-1">
        {totals.map((v, i) => {
          const heightPct = max > 0 ? (v / max) * 100 : 0;
          const isLast = i === totals.length - 1;
          return (
            <div key={i} className="flex-1 flex flex-col items-center justify-end gap-1">
              <div className="text-nano font-mono text-ul-text-muted tabular-nums">
                {v > 0 ? v.toFixed(3) : ''}
              </div>
              <div
                className={`w-full rounded-xs transition-all ${
                  isLast ? 'bg-ul-text' : 'bg-ul-bg-active'
                }`}
                style={{ height: `${Math.max(heightPct, 2)}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-nano font-mono text-ul-text-muted">
        {labels.map((l, i) => (
          <span key={i} className="flex-1 text-center">{l}</span>
        ))}
      </div>
    </div>
  );
}

// ── Activity rows ────────────────────────────────────────────────────

function ActivityTable({ transactions }: { transactions: BillingTransaction[] }) {
  // Group by date bucket (TODAY / YESTERDAY / MMM D). Maintains chronological
  // order of arrival within each bucket.
  const grouped = useMemo(() => {
    const groups: { bucket: string; rows: BillingTransaction[] }[] = [];
    for (const tx of transactions) {
      const bucket = dateBucket(tx.created_at);
      const last = groups[groups.length - 1];
      if (last && last.bucket === bucket) {
        last.rows.push(tx);
      } else {
        groups.push({ bucket, rows: [tx] });
      }
    }
    return groups;
  }, [transactions]);

  if (transactions.length === 0) {
    return (
      <div className="text-caption text-ul-text-muted py-6 text-center">
        No activity yet.
      </div>
    );
  }

  return (
    <div>
      {/* Column headers */}
      <div className="grid grid-cols-[80px_60px_140px_minmax(0,1fr)_90px] gap-3 px-2 pb-2 border-b border-ul-border text-nano font-mono text-ul-text-muted uppercase tracking-widest">
        <span>Date</span>
        <span>Time</span>
        <span>Source</span>
        <span>Memo</span>
        <span className="text-right">Amount</span>
      </div>
      {grouped.map((group, gi) => (
        <div key={gi}>
          {group.rows.map((tx, ri) => {
            const amt = tx.amount_light ?? 0;
            const positive = amt > 0;
            return (
              <div
                key={tx.id ?? `${gi}-${ri}`}
                className="grid grid-cols-[80px_60px_140px_minmax(0,1fr)_90px] gap-3 items-center px-2 py-2.5 border-b border-ul-border last:border-b-0 text-caption"
              >
                <span className="font-mono text-micro text-ul-text-muted uppercase tracking-wider">
                  {ri === 0 ? group.bucket : ''}
                </span>
                <span className="font-mono text-micro text-ul-text-muted">
                  {formatTimeOfDay(tx.created_at)}
                </span>
                <span className="text-ul-text-secondary truncate">
                  {humanizeCategory(tx.category)}
                </span>
                <span className="text-ul-text truncate">
                  {tx.description || '—'}
                </span>
                <span
                  className={`text-right font-mono text-caption font-medium tabular-nums ${
                    positive ? 'text-ul-success-strong' : 'text-ul-text'
                  }`}
                >
                  {positive ? '+' : '−'}✦{Math.abs(amt).toFixed(3)}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ── Balance tab ──────────────────────────────────────────────────────

function BalanceTab({
  hosting,
  transactions,
  onOpenAddLight,
}: {
  hosting: UserHosting | null;
  transactions: BillingTransaction[];
  onOpenAddLight?: () => void;
}) {
  const { dailyTotals, labels } = useMemo(
    () => bucketDailySums(transactions),
    [transactions],
  );
  const balance = hosting?.balance_light ?? 0;
  const { whole, fraction } = splitLightForHero(balance);

  return (
    <div className="px-8 py-7">
      <div className="grid grid-cols-[1.4fr_1fr] gap-3.5 mb-3.5">
        {/* Hero balance card */}
        <div className="bg-ul-bg-raised border border-ul-border rounded-card px-6 py-5">
          <div className="text-nano font-mono text-ul-text-muted uppercase tracking-widest">
            Available
          </div>
          <div className="text-display text-ul-text leading-none tracking-tighter flex items-baseline gap-1 mt-1">
            <span className="font-medium">✦</span>
            <span>{whole}</span>
            <span className="text-h2 text-ul-text-muted font-medium">{fraction}</span>
          </div>
          <div className="text-caption text-ul-text-secondary mt-1.5">
            spendable. Earnings withdraw separately.
          </div>
          <div className="flex gap-2 mt-4">
            <button
              type="button"
              onClick={onOpenAddLight}
              disabled={!onOpenAddLight}
              className="bg-ul-text text-white border-none px-3.5 py-2 rounded-md text-caption font-medium cursor-pointer hover:bg-ul-accent-hover disabled:opacity-60 disabled:cursor-not-allowed"
              title={onOpenAddLight ? undefined : 'Add Light flow arrives in Batch 5b'}
            >
              + Add Light
            </button>
            {hosting?.auto_topup_threshold_light !== undefined &&
              hosting.auto_topup_threshold_light !== null && (
                <button
                  type="button"
                  className="bg-transparent text-ul-text border border-ul-border px-3.5 py-2 rounded-md text-caption font-medium cursor-pointer hover:bg-ul-bg-hover"
                >
                  Auto top-up · ✦{formatLight(hosting.auto_topup_threshold_light, 0)}
                </button>
              )}
          </div>
        </div>
        {/* 7-day chart card */}
        <div className="bg-ul-bg border border-ul-border rounded-card px-6 py-5 flex flex-col justify-between">
          <SevenDayBars totals={dailyTotals} labels={labels} />
        </div>
      </div>

      {/* Recent activity */}
      <div className="flex items-baseline justify-between mt-3 mb-2">
        <div className="text-micro font-mono text-ul-text-muted uppercase tracking-widest">
          Recent activity
        </div>
        {/* "Full statement →" link — links to the future Activity view; for now a no-op label. */}
        <span className="text-micro text-ul-text-secondary cursor-default">
          {transactions.length} entries
        </span>
      </div>
      <ActivityTable transactions={transactions} />
    </div>
  );
}

// ── Earnings tab ────────────────────────────────────────────────────

function EarningsTab({
  earnings,
  connect,
  payouts,
  onWithdraw,
  onConnectBank,
  onToggleAutoAdd,
  autoAddSaving,
}: {
  earnings: UserEarnings | null;
  connect: ConnectStatus | null;
  payouts: PayoutRow[];
  onWithdraw: () => void;
  onConnectBank: () => void;
  onToggleAutoAdd: (next: boolean) => Promise<void>;
  autoAddSaving: boolean;
}) {
  const stats = [
    { label: 'Lifetime', value: earnings?.total_earned_light ?? 0 },
    {
      label: earnings ? `Last ${earnings.period}` : 'Last 30d',
      value: earnings?.period_earned_light ?? 0,
    },
    { label: 'Withdrawn', value: earnings?.total_withdrawn_light ?? 0 },
    { label: 'Withdrawable', value: earnings?.withdrawable_light ?? 0, accent: 'success' as const },
  ];
  const withdrawable = earnings?.withdrawable_light ?? 0;
  const autoAdd = earnings?.auto_add_earnings_to_balance ?? false;

  return (
    <div className="px-8 py-7">
      {/* 4-stat grid */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        {stats.map((s) => (
          <div key={s.label} className="bg-ul-bg-raised border border-ul-border rounded-md px-4 py-3.5">
            <div className="text-nano font-mono text-ul-text-muted uppercase tracking-widest">
              {s.label}
            </div>
            <div
              className={`text-h2 font-bold tabular-nums tracking-tight mt-1 ${
                s.accent === 'success' ? 'text-ul-success-strong' : 'text-ul-text'
              }`}
            >
              ✦{formatLight(s.value, 0)}
            </div>
          </div>
        ))}
      </div>

      {/* Bank payouts banner */}
      <div className="bg-ul-bg-raised border border-ul-border rounded-md px-5 py-4 flex items-center justify-between mb-3">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="text-body font-semibold">Bank payouts</div>
            <span
              className={`text-nano font-mono uppercase tracking-widest px-1.5 py-0.5 rounded-xs ${
                connect?.payouts_enabled
                  ? 'text-ul-success-strong bg-ul-success-soft'
                  : 'text-ul-error bg-ul-error-soft'
              }`}
            >
              {connect?.payouts_enabled
                ? 'Connected'
                : connect?.onboarded
                  ? 'Onboarding'
                  : 'Not connected'}
            </span>
          </div>
          <div className="text-caption text-ul-text-secondary mt-1">
            {connect?.payouts_enabled
              ? `Bank ready. ✦${formatLight(connect.withdrawable_earnings_light ?? withdrawable, 0)} withdrawable.`
              : 'Connect a bank to withdraw earnings. Deposits stay in-app.'}
          </div>
        </div>
        <div className="flex gap-2">
          {connect?.payouts_enabled && withdrawable > 0 && (
            <button
              type="button"
              onClick={onWithdraw}
              className="bg-ul-text text-white border-none px-3.5 py-2 rounded-md text-caption font-medium cursor-pointer hover:bg-ul-accent-hover"
            >
              Withdraw
            </button>
          )}
          <button
            type="button"
            onClick={onConnectBank}
            className={`px-3.5 py-2 rounded-md text-caption font-medium cursor-pointer ${
              connect?.payouts_enabled
                ? 'bg-ul-bg text-ul-text border border-ul-border hover:bg-ul-bg-hover'
                : 'bg-ul-text text-white border-none hover:bg-ul-accent-hover'
            }`}
          >
            {connect?.payouts_enabled ? 'Manage' : connect?.onboarded ? 'Resume' : 'Connect bank'}
          </button>
        </div>
      </div>

      {/* Auto-add earnings toggle */}
      <div className="bg-ul-bg-raised border border-ul-border rounded-md px-5 py-4 flex items-center justify-between mb-5">
        <div>
          <div className="text-body font-semibold">Auto-convert earnings to balance</div>
          <div className="text-caption text-ul-text-secondary mt-1">
            When on, every new tool earning is added to your spendable balance instantly at 1:1.
          </div>
        </div>
        <label className={`relative inline-flex items-center cursor-pointer ${autoAddSaving ? 'opacity-60' : ''}`}>
          <input
            type="checkbox"
            checked={autoAdd}
            disabled={autoAddSaving}
            onChange={(e) => { void onToggleAutoAdd(e.target.checked); }}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-ul-border peer-checked:bg-ul-success-strong rounded-full transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-5" />
        </label>
      </div>

      {/* Payout history */}
      {payouts.length > 0 && (
        <>
          <div className="text-micro font-mono text-ul-text-muted uppercase tracking-widest mb-1.5">
            Payout history
          </div>
          <div className="mb-5">
            {payouts.slice(0, 5).map((p) => (
              <div
                key={p.id}
                className="grid grid-cols-[100px_minmax(0,1fr)_90px_90px] gap-3 items-center px-2 py-3 border-b border-ul-border last:border-b-0 text-caption"
              >
                <div className="font-mono text-micro text-ul-text-muted">
                  {new Date(p.created_at).toLocaleDateString()}
                </div>
                <div className="font-mono text-micro text-ul-text-secondary truncate">
                  {p.stripe_payout_id ? `→ ${p.stripe_payout_id.slice(0, 16)}…` : '—'}
                </div>
                <div className="text-right">
                  <span
                    className={`text-nano font-mono uppercase tracking-widest px-1.5 py-0.5 rounded-xs ${
                      p.status === 'paid'
                        ? 'text-ul-success-strong bg-ul-success-soft'
                        : p.status === 'failed' || p.status === 'cancelled'
                          ? 'text-ul-error bg-ul-error-soft'
                          : 'text-ul-text-muted bg-ul-bg-active'
                    }`}
                  >
                    {p.status}
                  </span>
                </div>
                <div className="text-right font-mono text-caption font-medium tabular-nums">
                  ✦{formatLight(p.amount_light, 0)}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Earning apps list */}
      <div className="text-micro font-mono text-ul-text-muted uppercase tracking-widest mb-1.5">
        Earning apps
      </div>
      {earnings && earnings.by_app.length > 0 ? (
        <div>
          {earnings.by_app.slice(0, 10).map((app) => (
            <div
              key={app.app_id}
              className="grid grid-cols-[minmax(0,1fr)_100px_90px] gap-3.5 items-center px-2 py-3 border-b border-ul-border last:border-b-0 text-caption"
            >
              <div className="font-mono text-micro text-ul-text-secondary truncate">
                {app.app_id.slice(0, 12)}…
              </div>
              <div className="text-right text-ul-text-secondary">
                {app.call_count.toLocaleString()} calls
              </div>
              <div className="text-right font-mono text-caption font-medium tabular-nums text-ul-success-strong">
                +✦{formatLight(app.earned_light, 3)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-caption text-ul-text-muted py-6 text-center">
          No earnings yet — publish a tool to start earning.
        </div>
      )}
    </div>
  );
}

// ── Settings tab ─────────────────────────────────────────────────────

function SettingsTab({
  profile,
  billingAddress,
  onProfileSaved,
  onBillingSaved,
}: {
  profile: UserProfile | null;
  billingAddress: BillingAddress | null;
  onProfileSaved: () => Promise<void>;
  onBillingSaved: () => Promise<void>;
}) {
  // Display name + country (PATCH /api/user)
  const [displayName, setDisplayName] = useState<string>(profile?.display_name ?? '');
  const [country, setCountry] = useState<string>(profile?.country ?? '');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMsg, setProfileMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Billing address (PUT /api/user/billing-address)
  const [addr, setAddr] = useState<BillingAddress>(billingAddress ?? {});
  const [addrSaving, setAddrSaving] = useState(false);
  const [addrMsg, setAddrMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Keep local form state in sync when parent re-fetches profile/billing.
  useEffect(() => {
    if (profile) {
      setDisplayName(profile.display_name ?? '');
      setCountry(profile.country ?? '');
    }
  }, [profile]);
  useEffect(() => {
    if (billingAddress) setAddr(billingAddress);
  }, [billingAddress]);

  const onSaveProfile = async () => {
    setProfileSaving(true);
    setProfileMsg(null);
    const res = await updateUserProfile({
      display_name: displayName.trim() || undefined,
      country: country.trim() || undefined,
    });
    if (!res.ok) {
      setProfileMsg({ kind: 'err', text: res.errorMessage || 'Save failed.' });
    } else {
      setProfileMsg({ kind: 'ok', text: 'Saved.' });
      await onProfileSaved();
    }
    setProfileSaving(false);
  };

  const onSaveAddr = async () => {
    setAddrSaving(true);
    setAddrMsg(null);
    const res = await updateBillingAddress(addr);
    if (!res.ok) {
      setAddrMsg({ kind: 'err', text: res.errorMessage || 'Save failed.' });
    } else {
      setAddrMsg({ kind: 'ok', text: 'Saved.' });
      await onBillingSaved();
    }
    setAddrSaving(false);
  };

  return (
    <div className="px-8 py-7 max-w-3xl">
      {/* Profile section */}
      <SettingsSection title="Profile">
        <SettingsField label="Email">
          <div className="text-caption text-ul-text-secondary font-mono">{profile?.email ?? '—'}</div>
        </SettingsField>
        <SettingsField label="Display name">
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your name"
            className="w-full px-3 py-2 border border-ul-border rounded-md text-small bg-ul-bg outline-none focus:border-ul-text"
          />
        </SettingsField>
        <SettingsField label="Country (ISO 2-letter)">
          <input
            type="text"
            value={country}
            onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))}
            placeholder="US"
            maxLength={2}
            className="w-32 px-3 py-2 border border-ul-border rounded-md text-small font-mono uppercase tracking-widest bg-ul-bg outline-none focus:border-ul-text"
          />
        </SettingsField>
        <SettingsField label="Tier" hint="Managed by the platform">
          <span className="text-caption font-mono text-ul-text-secondary uppercase tracking-widest bg-ul-bg-active px-2 py-1 rounded-xs">
            {profile?.tier ?? '—'}
          </span>
        </SettingsField>
        <SettingsField label="Profile slug" hint="Auto-generated from display name">
          <span className="text-caption font-mono text-ul-text-muted">@{profile?.profile_slug ?? '—'}</span>
        </SettingsField>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void onSaveProfile()}
            disabled={profileSaving}
            className="bg-ul-text text-white border-none px-3.5 py-2 rounded-md text-caption font-medium cursor-pointer hover:bg-ul-accent-hover disabled:opacity-60"
          >
            {profileSaving ? 'Saving…' : 'Save profile'}
          </button>
          {profileMsg && (
            <span className={`text-caption ${profileMsg.kind === 'ok' ? 'text-ul-success-strong' : 'text-ul-error'}`}>
              {profileMsg.text}
            </span>
          )}
        </div>
      </SettingsSection>

      {/* Billing address */}
      <SettingsSection title="Billing address" hint="Used for tax location + Stripe customer metadata">
        <SettingsField label="Name">
          <input
            type="text"
            value={addr.name ?? ''}
            onChange={(e) => setAddr({ ...addr, name: e.target.value })}
            className="w-full px-3 py-2 border border-ul-border rounded-md text-small bg-ul-bg outline-none focus:border-ul-text"
          />
        </SettingsField>
        <SettingsField label="Line 1">
          <input
            type="text"
            value={addr.line1 ?? ''}
            onChange={(e) => setAddr({ ...addr, line1: e.target.value })}
            className="w-full px-3 py-2 border border-ul-border rounded-md text-small bg-ul-bg outline-none focus:border-ul-text"
          />
        </SettingsField>
        <SettingsField label="Line 2">
          <input
            type="text"
            value={addr.line2 ?? ''}
            onChange={(e) => setAddr({ ...addr, line2: e.target.value })}
            className="w-full px-3 py-2 border border-ul-border rounded-md text-small bg-ul-bg outline-none focus:border-ul-text"
          />
        </SettingsField>
        <div className="grid grid-cols-3 gap-3 mb-2">
          <div>
            <div className="text-nano font-mono text-ul-text-muted uppercase tracking-widest mb-1">City</div>
            <input
              type="text"
              value={addr.city ?? ''}
              onChange={(e) => setAddr({ ...addr, city: e.target.value })}
              className="w-full px-3 py-2 border border-ul-border rounded-md text-small bg-ul-bg outline-none focus:border-ul-text"
            />
          </div>
          <div>
            <div className="text-nano font-mono text-ul-text-muted uppercase tracking-widest mb-1">State</div>
            <input
              type="text"
              value={addr.state ?? ''}
              onChange={(e) => setAddr({ ...addr, state: e.target.value })}
              className="w-full px-3 py-2 border border-ul-border rounded-md text-small bg-ul-bg outline-none focus:border-ul-text"
            />
          </div>
          <div>
            <div className="text-nano font-mono text-ul-text-muted uppercase tracking-widest mb-1">Postal code</div>
            <input
              type="text"
              value={addr.postal_code ?? ''}
              onChange={(e) => setAddr({ ...addr, postal_code: e.target.value })}
              className="w-full px-3 py-2 border border-ul-border rounded-md text-small bg-ul-bg outline-none focus:border-ul-text"
            />
          </div>
        </div>
        <SettingsField label="Country (ISO 2-letter)">
          <input
            type="text"
            value={addr.country ?? ''}
            onChange={(e) => setAddr({ ...addr, country: e.target.value.toUpperCase().slice(0, 2) })}
            placeholder="US"
            maxLength={2}
            className="w-32 px-3 py-2 border border-ul-border rounded-md text-small font-mono uppercase tracking-widest bg-ul-bg outline-none focus:border-ul-text"
          />
        </SettingsField>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void onSaveAddr()}
            disabled={addrSaving}
            className="bg-ul-text text-white border-none px-3.5 py-2 rounded-md text-caption font-medium cursor-pointer hover:bg-ul-accent-hover disabled:opacity-60"
          >
            {addrSaving ? 'Saving…' : 'Save billing address'}
          </button>
          {addrMsg && (
            <span className={`text-caption ${addrMsg.kind === 'ok' ? 'text-ul-success-strong' : 'text-ul-error'}`}>
              {addrMsg.text}
            </span>
          )}
        </div>
      </SettingsSection>

      {/* BYOK status (read-only — full editor flagged as B16) */}
      <SettingsSection title="BYOK provider" hint="Bring-your-own-key inference routing">
        <div className="text-caption text-ul-text-secondary leading-relaxed mb-3">
          {profile?.byok_enabled
            ? `Active provider: ${profile.byok_provider ?? '—'}.`
            : 'No BYOK provider configured. Without a key, inference routes through Ultralight\'s Light meter.'}
        </div>
        <div className="text-nano font-mono text-ul-text-muted uppercase tracking-widest">
          Provider key management ships in a focused follow-up (DESIGN-FOLLOWUPS B16).
        </div>
      </SettingsSection>
    </div>
  );
}

function SettingsSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-8 last:mb-0">
      <div className="text-micro font-mono text-ul-text-muted uppercase tracking-widest mb-1.5">
        {title}
      </div>
      {hint && <div className="text-nano text-ul-text-muted mb-3">{hint}</div>}
      <div className="bg-ul-bg-raised border border-ul-border rounded-md p-4 space-y-3">
        {children}
      </div>
    </div>
  );
}

function SettingsField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-nano font-mono text-ul-text-muted uppercase tracking-widest">{label}</div>
        {hint && <div className="text-nano text-ul-text-muted">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

// ── ProfileView ──────────────────────────────────────────────────────

export default function ProfileView(_props: ProfileViewProps) {
  const [tab, setTab] = useState<Tab>('balance');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [hosting, setHosting] = useState<UserHosting | null>(null);
  const [transactions, setTransactions] = useState<BillingTransaction[]>([]);
  const [earnings, setEarnings] = useState<UserEarnings | null>(null);
  const [connect, setConnect] = useState<ConnectStatus | null>(null);
  const [payouts, setPayouts] = useState<PayoutRow[]>([]);
  const [billingAddress, setBillingAddress] = useState<BillingAddress | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addLightOpen, setAddLightOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [autoAddSaving, setAutoAddSaving] = useState(false);

  const reload = useCallback(async () => {
    const [p, h, t, e, c, py, ba] = await Promise.all([
      fetchUserProfile(),
      fetchUserHosting(),
      fetchUserTransactions({ limit: 50 }),
      fetchUserEarnings('30d'),
      fetchConnectStatus(),
      fetchPayoutHistory(20),
      fetchBillingAddress(),
    ]);
    setProfile(p);
    setHosting(h);
    setTransactions(t?.transactions ?? []);
    setEarnings(e);
    setConnect(c);
    setPayouts(py);
    setBillingAddress(ba);
    // Helpers return null on auth/HTTP failure rather than throwing, so
    // .catch never sees those. Surface a global error if the core profile
    // fetch failed (token expired, BE outage); other surfaces can be
    // missing without blocking the whole page.
    return { profile: p, hosting: h };
  }, []);

  // Open Stripe Connect onboarding. The BE returns a one-time URL; we
  // open it in the user's default browser. After Stripe redirects back,
  // the next visit / focus triggers reload() which refreshes /connect/status.
  const onConnectBank = useCallback(async () => {
    const country = profile?.country || 'US';
    const result = await startConnectOnboard({ country });
    if (!result.ok || !result.onboarding_url) {
      setError(result.errorMessage || 'Could not start onboarding.');
      return;
    }
    openExternal(result.onboarding_url);
  }, [profile?.country]);

  const onToggleAutoAdd = useCallback(async (enabled: boolean) => {
    setAutoAddSaving(true);
    const result = await toggleAutoAddEarnings(enabled);
    if (result.ok) await reload();
    setAutoAddSaving(false);
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    reload()
      .then((data) => {
        if (cancelled) return;
        if (!data.profile) {
          setError(
            'Failed to load profile. You may be signed out or the API is unreachable.',
          );
        }
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [reload]);

  const displayName = profile?.display_name ||
    profile?.email?.split('@')[0] ||
    'You';
  const initial = displayName.charAt(0).toUpperCase();

  // Sub-line stats: "active since <date> · N published · M acquired".
  // "Published / acquired" counts aren't on the profile response today —
  // computed from earnings.by_app (published) and noted as placeholder
  // for acquired. Flagged in DESIGN-FOLLOWUPS B14.
  const joined = profile?.created_at
    ? new Date(profile.created_at).toLocaleDateString(undefined, {
        month: 'short',
        year: 'numeric',
      })
    : '—';
  const publishedCount = earnings?.by_app.length ?? 0;

  return (
    <div className="bg-ul-bg h-full overflow-auto">
      {/* Identity strip */}
      <div className="px-8 pt-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <div className="w-14 h-14 rounded-full bg-ul-text text-white inline-flex items-center justify-center font-mono font-bold text-h3 tracking-tighter flex-shrink-0">
            {initial}
          </div>
          <div className="min-w-0">
            <div className="text-h3 text-ul-text tracking-tight font-bold truncate">
              {displayName}
            </div>
            <div className="text-caption text-ul-text-secondary font-mono mt-0.5">
              active since {joined.toLowerCase()} · {publishedCount} published · 0 acquired
            </div>
          </div>
        </div>
        {/* Tabs */}
        <div className="flex gap-0 flex-shrink-0">
          {(['balance', 'earnings', 'settings'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-caption font-mono uppercase tracking-widest border cursor-pointer transition-colors ${
                tab === t
                  ? 'bg-ul-text text-white border-ul-text'
                  : 'bg-ul-bg text-ul-text-secondary border-ul-border hover:bg-ul-bg-hover'
              } first:rounded-l-md last:rounded-r-md not-first:border-l-0`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Tab body */}
      {loading && !profile ? (
        <div className="px-8 py-6 text-caption text-ul-text-muted">Loading profile…</div>
      ) : error ? (
        <div className="px-8 py-6 text-caption text-ul-error">{error}</div>
      ) : (
        <>
          {tab === 'balance' && (
            <BalanceTab
              hosting={hosting}
              transactions={transactions}
              onOpenAddLight={() => setAddLightOpen(true)}
            />
          )}
          {tab === 'earnings' && (
            <EarningsTab
              earnings={earnings}
              connect={connect}
              payouts={payouts}
              onWithdraw={() => setWithdrawOpen(true)}
              onConnectBank={() => { void onConnectBank(); }}
              onToggleAutoAdd={onToggleAutoAdd}
              autoAddSaving={autoAddSaving}
            />
          )}
          {tab === 'settings' && (
            <SettingsTab
              profile={profile}
              billingAddress={billingAddress}
              onProfileSaved={async () => { await reload(); }}
              onBillingSaved={async () => { await reload(); }}
            />
          )}
        </>
      )}

      {addLightOpen && (
        <AddLightModal
          hosting={hosting}
          earnings={earnings}
          onClose={() => setAddLightOpen(false)}
          onSuccess={() => { void reload(); }}
        />
      )}

      {withdrawOpen && (
        <WithdrawModal
          connect={connect}
          withdrawableLight={earnings?.withdrawable_light ?? 0}
          onClose={() => setWithdrawOpen(false)}
          onSuccess={() => { void reload(); }}
        />
      )}
    </div>
  );
}
