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

import { useEffect, useMemo, useState } from 'react';
import {
  fetchUserProfile,
  fetchUserHosting,
  fetchUserTransactions,
  fetchUserEarnings,
  fetchConnectStatus,
  type UserProfile,
  type UserHosting,
  type BillingTransaction,
  type UserEarnings,
  type ConnectStatus,
} from '../lib/api';

interface ProfileViewProps {
  /** Open the Add Light modal. Wired in Batch 5b. */
  onOpenAddLight?: () => void;
  /** Open the Connect-onboard flow. Wired in Batch 5c. */
  onOpenPayoutOnboard?: () => void;
}

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

// ── Earnings tab (partial — full payout flow in 5c) ─────────────────

function EarningsTab({
  earnings,
  connect,
  onOpenPayoutOnboard,
}: {
  earnings: UserEarnings | null;
  connect: ConnectStatus | null;
  onOpenPayoutOnboard?: () => void;
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
      <div className="bg-ul-bg-raised border border-ul-border rounded-md px-5 py-4 flex items-center justify-between mb-5">
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
              ? `Bank ready. ✦${formatLight(connect.withdrawable_earnings_light, 0)} withdrawable.`
              : 'Connect a bank to withdraw earnings. Deposits stay in-app.'}
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenPayoutOnboard}
          disabled={!onOpenPayoutOnboard}
          className="bg-ul-text text-white border-none px-3.5 py-2 rounded-md text-caption font-medium cursor-pointer hover:bg-ul-accent-hover disabled:opacity-60 disabled:cursor-not-allowed"
          title={onOpenPayoutOnboard ? undefined : 'Payout flow arrives in Batch 5c'}
        >
          {connect?.payouts_enabled ? 'Manage' : connect?.onboarded ? 'Resume' : 'Connect bank'}
        </button>
      </div>

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

// ── Settings tab (stub for 5c) ───────────────────────────────────────

function SettingsTab({ profile }: { profile: UserProfile | null }) {
  return (
    <div className="px-8 py-7">
      <div className="text-caption text-ul-text-secondary leading-relaxed max-w-prose">
        Settings (API key, BYOK provider, billing address, country, featured app) arrive in
        Batch 5c. Profile data loaded:
      </div>
      <pre className="mt-3 p-3 bg-ul-bg-raised border border-ul-border rounded-md text-nano font-mono text-ul-text-muted overflow-x-auto">
        {JSON.stringify(
          {
            email: profile?.email,
            display_name: profile?.display_name,
            tier: profile?.tier,
            country: profile?.country,
            profile_slug: profile?.profile_slug,
          },
          null,
          2,
        )}
      </pre>
    </div>
  );
}

// ── ProfileView ──────────────────────────────────────────────────────

export default function ProfileView({ onOpenAddLight, onOpenPayoutOnboard }: ProfileViewProps) {
  const [tab, setTab] = useState<Tab>('balance');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [hosting, setHosting] = useState<UserHosting | null>(null);
  const [transactions, setTransactions] = useState<BillingTransaction[]>([]);
  const [earnings, setEarnings] = useState<UserEarnings | null>(null);
  const [connect, setConnect] = useState<ConnectStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      fetchUserProfile(),
      fetchUserHosting(),
      fetchUserTransactions({ limit: 50 }),
      fetchUserEarnings('30d'),
      fetchConnectStatus(),
    ])
      .then(([p, h, t, e, c]) => {
        if (cancelled) return;
        setProfile(p);
        setHosting(h);
        setTransactions(t?.transactions ?? []);
        setEarnings(e);
        setConnect(c);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

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
              onOpenAddLight={onOpenAddLight}
            />
          )}
          {tab === 'earnings' && (
            <EarningsTab
              earnings={earnings}
              connect={connect}
              onOpenPayoutOnboard={onOpenPayoutOnboard}
            />
          )}
          {tab === 'settings' && <SettingsTab profile={profile} />}
        </>
      )}
    </div>
  );
}
