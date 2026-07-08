// gx.notifications capability handler — the agent-facing read of the owner's
// notification inbox. Lets a connected agent surface "your Inbox Keeper was
// paused" in chat instead of the owner having to open the routine monitor.
// Scoped to the current user; read + mark-read only (writes come from platform
// subsystems, not agents).

import {
  countUnread,
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
} from "../notifications.ts";

export async function notificationsCapability(
  userId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const action = typeof args.action === "string" ? args.action : "list";

  if (action === "list") {
    const unreadOnly = args.unread_only === true;
    const rawLimit = Number(args.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20;
    const [notifications, unreadCount] = await Promise.all([
      listNotifications(userId, { unreadOnly, limit }),
      countUnread(userId),
    ]);
    return { notifications, unread_count: unreadCount };
  }

  if (action === "mark_read") {
    if (args.all === true) {
      return { ok: true, marked: await markAllNotificationsRead(userId) };
    }
    const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
    if (ids.length === 0) {
      throw new Error(
        'gx.notifications mark_read needs `ids: string[]` or `all: true`.',
      );
    }
    return { ok: true, marked: await markNotificationsRead(userId, ids) };
  }

  throw new Error(
    `Unknown gx.notifications action: ${action}. Use "list" or "mark_read".`,
  );
}
