import { createServerLogger } from './logging.ts';

export interface PlatformMcpAliasInfo {
  canonicalTool: string | null;
  replacement: string;
  removalBlocker?: string;
}

export const PLATFORM_MCP_ALIAS_MAP: Record<string, PlatformMcpAliasInfo> = {
  'ul.discover.desk': {
    canonicalTool: 'ul.discover',
    replacement: 'ul.discover({ scope: "desk" })',
  },
  'ul.discover.inspect': {
    canonicalTool: 'ul.discover',
    replacement: 'ul.discover({ scope: "inspect", app_id })',
  },
  'ul.discover.library': {
    canonicalTool: 'ul.discover',
    replacement: 'ul.discover({ scope: "library", query? })',
  },
  'ul.discover.appstore': {
    canonicalTool: 'ul.discover',
    replacement: 'ul.discover({ scope: "appstore", query?, task? })',
  },
  'ul.set.version': {
    canonicalTool: 'ul.set',
    replacement: 'ul.set({ app_id, version })',
  },
  'ul.set.visibility': {
    canonicalTool: 'ul.set',
    replacement: 'ul.set({ app_id, visibility })',
  },
  'ul.set.download': {
    canonicalTool: 'ul.set',
    replacement: 'ul.set({ app_id, download_access })',
  },
  'ul.set.supabase': {
    canonicalTool: 'ul.set',
    replacement: 'ul.set({ app_id, supabase_server })',
  },
  'ul.set.ratelimit': {
    canonicalTool: 'ul.set',
    replacement: 'ul.set({ app_id, calls_per_minute?, calls_per_day? })',
  },
  'ul.set.pricing': {
    canonicalTool: 'ul.set',
    replacement: 'ul.set({ app_id, default_price_light?, default_free_calls?, function_prices? })',
  },
  'ul.permissions.grant': {
    canonicalTool: 'ul.permissions',
    replacement: 'ul.permissions({ app_id, action: "grant", ... })',
  },
  'ul.permissions.revoke': {
    canonicalTool: 'ul.permissions',
    replacement: 'ul.permissions({ app_id, action: "revoke", ... })',
  },
  'ul.permissions.list': {
    canonicalTool: 'ul.permissions',
    replacement: 'ul.permissions({ app_id, action: "list" })',
  },
  'ul.permissions.export': {
    canonicalTool: 'ul.permissions',
    replacement: 'ul.permissions({ app_id, action: "export", format?, since?, until?, limit? })',
  },
  'ul.connect': {
    canonicalTool: 'ul.secrets',
    replacement: 'ul.secrets({ app_id, secrets })',
  },
  'ul.connections': {
    canonicalTool: 'ul.secrets',
    replacement: 'ul.secrets({ app_id? })',
  },
  'ul.memory.read': {
    canonicalTool: 'ul.memory',
    replacement: 'ul.memory({ action: "read", owner_email? })',
  },
  'ul.memory.write': {
    canonicalTool: 'ul.memory',
    replacement: 'ul.memory({ action: "write", content, append? })',
  },
  'ul.memory.append': {
    canonicalTool: 'ul.memory',
    replacement: 'ul.memory({ action: "write", content, append: true })',
  },
  'ul.memory.recall': {
    canonicalTool: 'ul.memory',
    replacement: 'ul.memory({ action: "recall", key, value?, scope?, owner_email? })',
  },
  'ul.memory.remember': {
    canonicalTool: 'ul.memory',
    replacement: 'ul.memory({ action: "recall", key, value, scope? })',
  },
  'ul.memory.query': {
    canonicalTool: 'ul.memory',
    replacement: 'ul.memory({ action: "query", prefix?, limit?, owner_email? })',
  },
  'ul.memory.forget': {
    canonicalTool: 'ul.memory',
    replacement: 'ul.memory({ action: "query", delete_key: key, scope? })',
  },
  'ul.markdown.publish': {
    canonicalTool: 'ul.upload',
    replacement: 'ul.upload({ type: "page", slug, content, title?, tags?, shared_with?, published? })',
  },
  'ul.markdown.list': {
    canonicalTool: null,
    replacement: 'No canonical replacement published yet.',
    removalBlocker: 'Page listing still depends on the legacy alias surface.',
  },
  'ul.markdown.share': {
    canonicalTool: null,
    replacement: 'No canonical replacement published yet.',
    removalBlocker: 'Page and memory share actions still depend on the legacy alias surface.',
  },
  'ul.like': {
    canonicalTool: 'ul.rate',
    replacement: 'ul.rate({ app_id?, content_id?, rating: "like" })',
  },
  'ul.dislike': {
    canonicalTool: 'ul.rate',
    replacement: 'ul.rate({ app_id?, content_id?, rating: "dislike" })',
  },
  'ul.lint': {
    canonicalTool: 'ul.test',
    replacement: 'ul.test({ files, lint_only: true, strict? })',
  },
  'ul.scaffold': {
    canonicalTool: 'ul.download',
    replacement: 'ul.download({ name, description, functions?, storage?, permissions? })',
  },
  'ul.health': {
    canonicalTool: null,
    replacement: 'No canonical replacement published yet.',
    removalBlocker: 'Health inspection still depends on the legacy alias surface.',
  },
  'ul.gaps': {
    canonicalTool: null,
    replacement: 'No canonical replacement published yet.',
    removalBlocker: 'Gap review still depends on the legacy alias surface.',
  },
  'ul.shortcomings': {
    canonicalTool: null,
    replacement: 'No canonical replacement published yet.',
    removalBlocker: 'Shortcoming review still depends on the legacy alias surface.',
  },
  'ul.execute': {
    canonicalTool: 'ul.codemode',
    replacement: 'ul.codemode({ code })',
  },
};

export interface PlatformMcpAliasLogInput {
  alias: string;
  userId: string;
  sessionId?: string | null;
}

export function buildPlatformMcpAliasLogEntry(
  input: PlatformMcpAliasLogInput,
): Record<string, unknown> {
  const aliasInfo = PLATFORM_MCP_ALIAS_MAP[input.alias] || null;
  return {
    event: 'platform_mcp_alias',
    alias: input.alias,
    canonical_tool: aliasInfo?.canonicalTool || null,
    replacement: aliasInfo?.replacement || null,
    removal_blocker: aliasInfo?.removalBlocker || undefined,
    user_id: input.userId,
    session_id: input.sessionId || undefined,
    known_alias: !!aliasInfo,
  };
}

export function parseDisabledPlatformMcpAliases(
  rawValue: string | null | undefined,
): Set<string> {
  const disabledAliases = new Set<string>();
  if (!rawValue) {
    return disabledAliases;
  }

  for (const token of rawValue.split(",").map((part) => part.trim()).filter(Boolean)) {
    if (token === "removable") {
      for (const [alias, info] of Object.entries(PLATFORM_MCP_ALIAS_MAP)) {
        if (info.canonicalTool) {
          disabledAliases.add(alias);
        }
      }
      continue;
    }

    if (PLATFORM_MCP_ALIAS_MAP[token]) {
      disabledAliases.add(token);
    }
  }

  return disabledAliases;
}

export function buildPlatformMcpAliasRetiredMessage(alias: string): string {
  const aliasInfo = PLATFORM_MCP_ALIAS_MAP[alias];
  if (!aliasInfo) {
    return `The tool alias "${alias}" has been retired.`;
  }
  if (aliasInfo.canonicalTool) {
    return `The tool alias "${alias}" has been retired. Use ${aliasInfo.replacement} instead.`;
  }
  return `The tool alias "${alias}" has been retired. ${aliasInfo.removalBlocker || "No canonical replacement is published for it."}`;
}

export function logPlatformMcpAliasUsage(
  input: PlatformMcpAliasLogInput,
): void {
  createServerLogger('PLATFORM-ALIAS').warn(
    'Legacy platform alias invoked',
    buildPlatformMcpAliasLogEntry(input),
  );
}
