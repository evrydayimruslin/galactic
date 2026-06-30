// Defaults Manager — a PRIVATE Agent for the platform owner. It curates the
// pre-install defaults: the set of Agents new accounts are seeded with at first
// sign-in (forward-only — editing it never touches existing users).
//
// It is JUST A NORMAL private Agent. The functions are owner-only because the
// Agent is private (only the account that deployed it can call them), and it
// stores the list in its OWN app-data (ultralight.store/load), exactly like any
// Agent stores data. No platform privileges, no special binding, no admin token.
// The platform's signup seeding reads this list from the Agent named by the
// DEFAULTS_SOURCE_APP config.
//
// Deploy PRIVATE, then point DEFAULTS_SOURCE_APP at this Agent's slug.

// deno-lint-ignore no-explicit-any
const ultralight = (globalThis as any).ultralight;

interface DefaultRef {
  app_id: string;
  badge?: string | null;
}

async function loadList(): Promise<DefaultRef[]> {
  const stored = await ultralight.load("defaults");
  return Array.isArray(stored) ? stored as DefaultRef[] : [];
}

/** List the current default Agents (the app ids seeded into new accounts). */
export async function list_defaults() {
  return { defaults: await loadList() };
}

/** Add an Agent (by app id) to the defaults. Affects FUTURE signups only. */
export async function add_default(args: { app_id: string; badge?: string }) {
  const appId = (args?.app_id || "").toString().trim();
  if (!appId) throw new Error("app_id is required");
  const list = await loadList();
  if (!list.some((d) => d.app_id === appId)) {
    list.push({ app_id: appId, badge: args?.badge?.toString().trim() || null });
    await ultralight.store("defaults", list);
  }
  return { added: appId, defaults: list };
}

/** Remove an Agent from the defaults. Stops future seeding; existing users keep it. */
export async function remove_default(args: { app_id: string }) {
  const appId = (args?.app_id || "").toString().trim();
  if (!appId) throw new Error("app_id is required");
  const list = (await loadList()).filter((d) => d.app_id !== appId);
  await ultralight.store("defaults", list);
  return { removed: appId, defaults: list };
}
