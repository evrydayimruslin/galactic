import { getEnv } from "../lib/env.ts";

export const ROUTINES_FLAG_ENV = "ROUTINES_ENABLED";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);

/**
 * Kill switch for durable user routines. The per-minute routine-executor cron
 * and the routine APIs read tables (user_routines, routine_runs, ...) that
 * only exist where the routines schema is applied, so the flag defaults OFF
 * for any environment without it. Both production and staging apply the full
 * migration set and declare ROUTINES_ENABLED="1" in wrangler.toml — routines
 * are LIVE in prod (flipped in PR #62 once the prod schema was confirmed
 * applied); this flag remains as the operational off switch.
 */
export function isRoutinesEnabled(): boolean {
  return ENABLED_VALUES.has(getEnv(ROUTINES_FLAG_ENV).trim().toLowerCase());
}
