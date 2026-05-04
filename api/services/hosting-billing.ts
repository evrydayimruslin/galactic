// Hosting Billing Service
// Per-app billing: each published app/page has its own billing clock (hosting_last_billed_at).
// Charges ✦2.25/MB/hour for each published app/page from the moment it was published.
// Charges ✦0.045/MB/hour for user data storage exceeding the 100MB soft cap (user-level clock).
// Both charges debit from the same bucketed spendable Light balance.
// No free tier for hosting — every published MB costs from the first byte.
// 100MB soft cap for combined source/user data — overage billed hourly.
// Users hold a balance_light that drains continuously.
// Balance → 0 = published content goes offline (hosting_suspended = true).
// Runs hourly via setInterval (same pattern as subscription-expiry.ts).

import { getEnv } from "../lib/env.ts";
import {
  COMBINED_FREE_TIER_BYTES,
  DATA_RATE_LIGHT_PER_MB_PER_HOUR,
  HOSTING_RATE_LIGHT_PER_MB_PER_HOUR,
} from "../../shared/types/index.ts";
import { refreshGpuReliabilityView } from "./gpu/reliability.ts";

const RATE_LIGHT_PER_MB_PER_HOUR = HOSTING_RATE_LIGHT_PER_MB_PER_HOUR;
const DATA_RATE_LIGHT = DATA_RATE_LIGHT_PER_MB_PER_HOUR;

interface BillingUser {
  id: string;
  balance_light: number;
  hosting_last_billed_at: string;
  // Data storage metering fields
  data_storage_used_bytes: number;
  storage_used_bytes: number;
  storage_limit_bytes: number;
}

interface UserStorage {
  app_bytes: number;
  content_bytes: number;
}

export interface BillingResult {
  usersProcessed: number;
  usersSuspended: number;
  totalChargedLight: number;
  degraded: boolean;
  errors: string[];
  details: {
    userId: string;
    storageMb: number;
    hostingChargedLight: number;
    dataOverageMb: number;
    dataOverageLight: number;
    totalChargedLight: number;
    newBalance: number;
    suspended: boolean;
  }[];
}

/**
 * Process hosting billing for all users with published content.
 *
 * 1. Query users who have non-zero balance or published content
 * 2. For each user, calculate total storage (apps + pages)
 * 3. Compute cost based on hours since last billed
 * 4. Deduct from balance; suspend if depleted
 */
export async function processHostingBilling(): Promise<BillingResult> {
  const SUPABASE_URL = getEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  const result: BillingResult = {
    usersProcessed: 0,
    usersSuspended: 0,
    totalChargedLight: 0,
    degraded: false,
    errors: [],
    details: [],
  };

  const markDegraded = (message: string, detail?: unknown) => {
    result.degraded = true;
    result.errors.push(message);
    if (detail !== undefined) {
      console.error("[BILLING]", message, detail);
    }
  };

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    markDegraded("Supabase not configured; hosting billing skipped");
    return result;
  }

  const headers = {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };
  const writeHeaders = {
    ...headers,
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
  };

  try {
    // 1. Find users who need billing:
    //    - balance_light > 0 (have balance for publisher hosting), OR
    //    - data_storage_used_bytes > 0 (have user data that may need overage billing)
    const usersRes = await fetch(
      `${SUPABASE_URL}/rest/v1/users?or=(balance_light.gt.0,data_storage_used_bytes.gt.0)` +
        `&select=id,balance_light,hosting_last_billed_at,data_storage_used_bytes,storage_used_bytes,storage_limit_bytes`,
      { headers },
    );

    if (!usersRes.ok) {
      const err = await usersRes.text();
      markDegraded(`Failed to query users: ${err}`);
      return result;
    }

    const users: BillingUser[] = await usersRes.json();

    if (users.length === 0) {
      return result; // No billable users
    }

    console.log(
      `[BILLING] Processing ${users.length} user(s) with positive balance`,
    );

    // 2. Process each user
    for (const user of users) {
      try {
        // 2a. Get all published apps with per-app billing clocks
        const appStorageRes = await fetch(
          `${SUPABASE_URL}/rest/v1/apps?owner_id=eq.${user.id}&deleted_at=is.null&hosting_suspended=eq.false` +
            `&visibility=in.(public,unlisted)&select=id,name,storage_bytes,hosting_last_billed_at`,
          { headers },
        );

        let totalAppBytes = 0;
        let publishedAppCount = 0;
        let hostingCostLight = 0;
        const appCharges: Array<
          { id: string; name: string; mb: number; hours: number; light: number }
        > = [];
        const now = new Date();

        if (appStorageRes.ok) {
          const apps = await appStorageRes.json() as Array<{
            id: string;
            name: string;
            storage_bytes: number | null;
            hosting_last_billed_at: string | null;
          }>;
          publishedAppCount = apps.length;
          for (const app of apps) {
            const bytes = app.storage_bytes || 0;
            totalAppBytes += bytes;
            const mb = bytes / (1024 * 1024);
            // Per-app billing clock — each app bills from its own last_billed_at
            const lastBilled = app.hosting_last_billed_at
              ? new Date(app.hosting_last_billed_at)
              : now;
            const hours = Math.max(
              (now.getTime() - lastBilled.getTime()) / (1000 * 60 * 60),
              0,
            );
            if (hours < 1 / 60) continue; // < 1 minute — skip
            const light = mb * RATE_LIGHT_PER_MB_PER_HOUR * hours;
            if (light > 0) {
              hostingCostLight += light;
              appCharges.push({ id: app.id, name: app.name, mb, hours, light });
            }
          }
        } else {
          markDegraded(
            `Failed to query published apps for ${user.id}: ${await appStorageRes
              .text()}`,
          );
        }

        // 2b. Get all published pages with per-page billing clocks
        const contentStorageRes = await fetch(
          `${SUPABASE_URL}/rest/v1/content?owner_id=eq.${user.id}&type=eq.page&hosting_suspended=eq.false` +
            `&visibility=eq.public&select=id,title,size,hosting_last_billed_at`,
          { headers },
        );

        let totalContentBytes = 0;
        const pageCharges: Array<
          { id: string; name: string; mb: number; hours: number; light: number }
        > = [];

        if (contentStorageRes.ok) {
          const pages = await contentStorageRes.json() as Array<{
            id: string;
            title: string;
            size: number | null;
            hosting_last_billed_at: string | null;
          }>;
          for (const page of pages) {
            const bytes = page.size || 0;
            totalContentBytes += bytes;
            const mb = bytes / (1024 * 1024);
            const lastBilled = page.hosting_last_billed_at
              ? new Date(page.hosting_last_billed_at)
              : now;
            const hours = Math.max(
              (now.getTime() - lastBilled.getTime()) / (1000 * 60 * 60),
              0,
            );
            if (hours < 1 / 60) continue;
            const light = mb * RATE_LIGHT_PER_MB_PER_HOUR * hours;
            if (light > 0) {
              hostingCostLight += light;
              pageCharges.push({
                id: page.id,
                name: page.title || "Untitled page",
                mb,
                hours,
                light,
              });
            }
          }
        } else {
          markDegraded(
            `Failed to query published pages for ${user.id}: ${await contentStorageRes
              .text()}`,
          );
        }

        const totalHostingBytes = totalAppBytes + totalContentBytes;
        const totalMb = totalHostingBytes / (1024 * 1024);

        // 2c. Calculate data storage overage (user-level timing, not per-app)
        const combinedStorageBytes = (user.storage_used_bytes || 0) +
          (user.data_storage_used_bytes || 0);
        const freeBytes = user.storage_limit_bytes || COMBINED_FREE_TIER_BYTES;
        const overageBytes = Math.max(0, combinedStorageBytes - freeBytes);
        const dataOverageMb = overageBytes / (1024 * 1024);

        // Data overage uses user-level billing clock
        const userLastBilled = new Date(user.hosting_last_billed_at);
        const userHours = Math.max(
          (now.getTime() - userLastBilled.getTime()) / (1000 * 60 * 60),
          0,
        );
        const dataOverageCostLight = (userHours >= 1 / 60 && dataOverageMb > 0)
          ? dataOverageMb * DATA_RATE_LIGHT * userHours
          : 0;

        // Skip users with nothing to bill
        if (hostingCostLight === 0 && dataOverageCostLight === 0) continue;

        const totalCostLight = hostingCostLight + dataOverageCostLight;

        // Round to 2 decimal places (sub-Light precision for fractional rates)
        const chargedLight = Math.max(
          Math.round(totalCostLight * 100) / 100,
          totalCostLight > 0 ? 0.01 : 0,
        );

        // 2d. Atomic debit via Postgres RPC — prevents race with concurrent webhook credits
        const debitRes = await fetch(
          `${SUPABASE_URL}/rest/v1/rpc/debit_light`,
          {
            method: "POST",
            headers: {
              ...headers,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              p_user_id: user.id,
              p_amount_light: chargedLight,
              p_reason: "hosting_billing",
              p_update_billed_at: true,
              p_allow_partial: true,
              p_metadata: {
                hosting_light: Math.round(hostingCostLight * 100) / 100,
                data_overage_light: Math.round(dataOverageCostLight * 100) /
                  100,
                published_app_count: publishedAppCount,
                hosting_mb: totalMb,
                data_overage_mb: dataOverageMb,
              },
            }),
          },
        );

        if (!debitRes.ok) {
          const err = await debitRes.text();
          markDegraded(`Failed to debit balance for ${user.id}: ${err}`);
          continue;
        }

        const debitResult = await debitRes.json() as Array<{
          old_balance: number;
          new_balance: number;
          was_depleted: boolean;
          amount_debited?: number;
        }>;

        if (!debitResult || debitResult.length === 0) {
          markDegraded(`Debit RPC returned empty for ${user.id}`);
          continue;
        }

        const {
          new_balance: newBalance,
          was_depleted: suspended,
          amount_debited: amountDebited,
        } = debitResult[0];
        const actualChargedLight = typeof amountDebited === "number"
          ? amountDebited
          : chargedLight;
        const chargeRatio = chargedLight > 0
          ? Math.min(1, actualChargedLight / chargedLight)
          : 1;

        // Update per-app/page billing clocks after successful debit
        const nowStr = now.toISOString();
        if (appCharges.length > 0) {
          const appIds = appCharges.map((a) => a.id).join(",");
          try {
            const updateAppsRes = await fetch(
              `${SUPABASE_URL}/rest/v1/apps?id=in.(${appIds})`,
              {
                method: "PATCH",
                headers: writeHeaders,
                body: JSON.stringify({ hosting_last_billed_at: nowStr }),
              },
            );
            if (!updateAppsRes.ok) {
              markDegraded(
                `Failed to update app billing clocks for ${user.id}: ${await updateAppsRes
                  .text()}`,
              );
            }
          } catch (clockErr) {
            markDegraded(
              `Failed to update app billing clocks for ${user.id}`,
              clockErr,
            );
          }
        }
        if (pageCharges.length > 0) {
          const pageIds = pageCharges.map((p) => p.id).join(",");
          try {
            const updatePagesRes = await fetch(
              `${SUPABASE_URL}/rest/v1/content?id=in.(${pageIds})`,
              {
                method: "PATCH",
                headers: writeHeaders,
                body: JSON.stringify({ hosting_last_billed_at: nowStr }),
              },
            );
            if (!updatePagesRes.ok) {
              markDegraded(
                `Failed to update page billing clocks for ${user.id}: ${await updatePagesRes
                  .text()}`,
              );
            }
          } catch (clockErr) {
            markDegraded(
              `Failed to update page billing clocks for ${user.id}`,
              clockErr,
            );
          }
        }

        // Log billing transaction(s) — separate line items for hosting vs data overage
        try {
          const txRows: Array<Record<string, unknown>> = [];
          if (hostingCostLight > 0) {
            txRows.push({
              user_id: user.id,
              type: "charge",
              category: "hosting",
              description: `Hosting: ${publishedAppCount} app(s), ${
                totalMb.toFixed(2)
              } MB`,
              amount_light: -Math.max(
                Math.round(hostingCostLight * chargeRatio * 100) / 100,
                chargeRatio > 0 ? 0.01 : 0,
              ),
              balance_after_light: newBalance +
                (dataOverageCostLight > 0
                  ? Math.max(Math.round(dataOverageCostLight * 100) / 100, 0.01)
                  : 0),
              metadata: {
                hosting_mb: totalMb,
                rate: RATE_LIGHT_PER_MB_PER_HOUR,
                apps: appCharges.map((a) => ({
                  id: a.id,
                  name: a.name,
                  mb: +a.mb.toFixed(4),
                  hours: +a.hours.toFixed(2),
                  light: +a.light.toFixed(4),
                })),
                pages: pageCharges.length > 0
                  ? pageCharges.map((p) => ({
                    id: p.id,
                    name: p.name,
                    mb: +p.mb.toFixed(4),
                    hours: +p.hours.toFixed(2),
                    light: +p.light.toFixed(4),
                  }))
                  : undefined,
              },
            });
          }
          if (dataOverageCostLight > 0) {
            txRows.push({
              user_id: user.id,
              type: "charge",
              category: "data_storage",
              description: `Data storage overage: ${
                dataOverageMb.toFixed(2)
              } MB over ${(freeBytes / (1024 * 1024)).toFixed(0)} MB free`,
              amount_light: -Math.max(
                Math.round(dataOverageCostLight * chargeRatio * 100) / 100,
                chargeRatio > 0 ? 0.01 : 0,
              ),
              balance_after_light: newBalance,
              metadata: {
                overage_mb: dataOverageMb,
                hours: userHours,
                rate: DATA_RATE_LIGHT,
              },
            });
          }
          if (txRows.length > 0) {
            await fetch(`${SUPABASE_URL}/rest/v1/billing_transactions`, {
              method: "POST",
              headers: writeHeaders,
              body: JSON.stringify(txRows),
            }).catch(() => {}); // Fire-and-forget — don't break billing if tx log fails
          }
        } catch { /* never break billing for logging */ }

        // 2f. If balance depleted, suspend all their published content.
        // Legacy saved-payment auto top-up is disabled; external money enters
        // only through wallet funding or wire transfer.
        if (suspended) {
          // Suspend apps
          try {
            const suspendAppsRes = await fetch(
              `${SUPABASE_URL}/rest/v1/apps?owner_id=eq.${user.id}&deleted_at=is.null&hosting_suspended=eq.false` +
                `&visibility=in.(public,unlisted)`,
              {
                method: "PATCH",
                headers: writeHeaders,
                body: JSON.stringify({ hosting_suspended: true }),
              },
            );
            if (!suspendAppsRes.ok) {
              markDegraded(
                `Failed to suspend apps for ${user.id}: ${await suspendAppsRes
                  .text()}`,
              );
            }
          } catch (suspendErr) {
            markDegraded(`Failed to suspend apps for ${user.id}`, suspendErr);
          }

          // Suspend pages
          try {
            const suspendPagesRes = await fetch(
              `${SUPABASE_URL}/rest/v1/content?owner_id=eq.${user.id}&type=eq.page&hosting_suspended=eq.false`,
              {
                method: "PATCH",
                headers: writeHeaders,
                body: JSON.stringify({ hosting_suspended: true }),
              },
            );
            if (!suspendPagesRes.ok) {
              markDegraded(
                `Failed to suspend pages for ${user.id}: ${await suspendPagesRes
                  .text()}`,
              );
            }
          } catch (suspendErr) {
            markDegraded(`Failed to suspend pages for ${user.id}`, suspendErr);
          }

          result.usersSuspended++;
          console.log(
            `[BILLING] User ${user.id}: SUSPENDED — balance depleted ` +
              `(hosting: ${totalMb.toFixed(2)} MB, data overage: ${
                dataOverageMb.toFixed(2)
              } MB, charged ✦${actualChargedLight.toFixed(2)})`,
          );
        }

        result.usersProcessed++;
        result.totalChargedLight += actualChargedLight;
        const hostingRounded = Math.max(
          Math.round(hostingCostLight * 100) / 100,
          hostingCostLight > 0 ? 0.01 : 0,
        );
        const dataOverageRounded = Math.round(dataOverageCostLight * 100) / 100;
        result.details.push({
          userId: user.id,
          storageMb: totalMb,
          hostingChargedLight: hostingRounded,
          dataOverageMb,
          dataOverageLight: dataOverageRounded,
          totalChargedLight: actualChargedLight,
          newBalance,
          suspended,
        });
      } catch (userErr) {
        const msg = userErr instanceof Error
          ? userErr.message
          : String(userErr);
        markDegraded(`Error processing ${user.id}: ${msg}`);
      }
    }

    if (result.usersProcessed > 0) {
      console.log(
        `[BILLING] Complete: ${result.usersProcessed} user(s) billed, ` +
          `${result.usersSuspended} suspended, ` +
          `✦${result.totalChargedLight.toFixed(2)} total charged, ` +
          `${result.errors.length} error(s)`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markDegraded(`Fatal error: ${msg}`);
  }

  return result;
}

/**
 * Unsuspend all content for a user after they top up their balance.
 */
export async function unsuspendContent(
  userId: string,
): Promise<{ apps: number; pages: number }> {
  const SUPABASE_URL = getEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  const writeHeaders = {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation",
  };

  const nowStr = new Date().toISOString();

  // Unsuspend apps and reset per-app billing clocks (don't charge for suspended period)
  const appsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/apps?owner_id=eq.${userId}&hosting_suspended=eq.true&select=id`,
    {
      method: "PATCH",
      headers: writeHeaders,
      body: JSON.stringify({
        hosting_suspended: false,
        hosting_last_billed_at: nowStr,
      }),
    },
  );
  const appsUnsuspended = appsRes.ok
    ? (await appsRes.json() as Array<{ id: string }>).length
    : 0;

  // Unsuspend pages and reset per-page billing clocks
  const pagesRes = await fetch(
    `${SUPABASE_URL}/rest/v1/content?owner_id=eq.${userId}&type=eq.page&hosting_suspended=eq.true&select=id`,
    {
      method: "PATCH",
      headers: writeHeaders,
      body: JSON.stringify({
        hosting_suspended: false,
        hosting_last_billed_at: nowStr,
      }),
    },
  );
  const pagesUnsuspended = pagesRes.ok
    ? (await pagesRes.json() as Array<{ id: string }>).length
    : 0;

  if (appsUnsuspended > 0 || pagesUnsuspended > 0) {
    console.log(
      `[BILLING] Unsuspended ${appsUnsuspended} app(s), ${pagesUnsuspended} page(s) for user ${userId}`,
    );
  }

  return { apps: appsUnsuspended, pages: pagesUnsuspended };
}

/**
 * Start the hosting billing job.
 * Runs strictly every hour — no startup run, so deploys don't trigger extra charges.
 * Per-app billing clocks ensure no time is lost between intervals.
 */
export function startHostingBillingJob(): void {
  const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  console.log(
    "[BILLING] Starting hosting billing job (hourly, no startup run)",
  );

  // Run every hour — per-app clocks accumulate naturally, so the first
  // interval after a deploy just bills for however long since each app's
  // last_billed_at (up to ~2h if deploy happened right before the old
  // interval would have fired). No charge is lost, no double-billing.
  setInterval(async () => {
    try {
      const billingResult = await processHostingBilling();
      if (billingResult.degraded || billingResult.errors.length > 0) {
        console.error(
          "[BILLING] Scheduled run completed in degraded mode:",
          billingResult.errors,
        );
      }
    } catch (err) {
      console.error("[BILLING] Scheduled billing failed:", err);
    }

    // Refresh GPU reliability materialized view (fire-and-forget)
    try {
      await refreshGpuReliabilityView();
    } catch (err) {
      console.error("[GPU-RELIABILITY] Hourly refresh failed:", err);
    }
  }, INTERVAL_MS);
}
