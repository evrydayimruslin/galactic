// System Agent definitions — 3 persistent singleton agents that form
// the platform's always-available infrastructure layer.
// Each routes through the Flash orchestrate pipeline with per-agent
// persona injection and Skills.md from R2.

export const SYSTEM_AGENT_TYPES = [
  'tool_builder',
  'tool_marketer',
  'platform_manager',
] as const;

export type SystemAgentType = typeof SYSTEM_AGENT_TYPES[number];

export function isSystemAgentType(value: string | null | undefined): value is SystemAgentType {
  return SYSTEM_AGENT_TYPES.includes(value as SystemAgentType);
}

export interface StarterPrompt {
  label: string;          // short display text for the chip
  prompt: string;         // full message sent on click
}

export interface SystemAgentConfig {
  type: SystemAgentType;
  name: string;
  role: string;
  icon: string;
  persona: string;        // injected into Flash's routing + prompt prompts
  skillsPath: string;     // R2 path to Skills.md for this agent type
  description: string;
  welcome: {
    greeting: string;     // warm intro paragraph shown on empty state
    starters: StarterPrompt[];
  };
}

/** State snapshot synced to server KV for Flash's Context Index */
export interface SystemAgentState {
  type: string;
  name: string;
  tools: string[];
  stateSummary: string | null;
  status: string;
}

/** Fixed display order in NavSidebar */
export const SYSTEM_AGENT_ORDER: SystemAgentType[] = [
  'tool_marketer',
  'tool_builder',
  'platform_manager',
];

export const SYSTEM_AGENTS: SystemAgentConfig[] = [
  {
    type: 'tool_builder',
    name: 'Tool Maker',
    role: 'builder',
    icon: 'Wrench',
    persona: 'Tool Maker, an expert MCP developer who builds, tests, and deploys Ultralight apps, widgets, and Command cards',
    skillsPath: 'system-agents/tool_builder/skills.md',
    description: 'Build, test, and deploy MCP tools, widgets, and Command cards',
    welcome: {
      greeting: 'I help you build, test, and deploy MCP tools on Ultralight, including widgets and Command cards. Describe what you want to create and I\'ll write the code, set up the database, and get it running.',
      starters: [
        { label: 'Build a new tool from scratch', prompt: 'Help me build a new MCP tool from scratch' },
        { label: 'Build a Command card', prompt: 'Help me add a widget and Command card to an MCP app' },
        { label: 'Debug my app\'s code', prompt: 'Help me debug my app\'s function code' },
        { label: 'Deploy an app to production', prompt: 'Walk me through deploying my app to production' },
        { label: 'SDK quick reference', prompt: 'Show me the Ultralight SDK reference for database, KV, and HTTP' },
      ],
    },
  },
  {
    type: 'tool_marketer',
    name: 'Tool Dealer',
    role: 'marketer',
    icon: 'Store',
    persona: 'Tool Dealer, a marketplace specialist who discovers, evaluates, publishes, and monetizes tools, widgets, and Command cards. IMPORTANT: When marketplace search returns zero results or only weak matches (nothing that clearly fits the user need), you MUST report a capability gap via ul.rate({ shortcoming: { type: "capability_gap", summary, context } }) and include the user\'s original request in that context. This feeds the platform\'s demand detection pipeline. Always try to help the user regardless — suggest alternatives, partial matches, dashboard-ready surfaces, or offer to escalate to Tool Maker if the gap is significant.',
    skillsPath: 'system-agents/tool_marketer/skills.md',
    description: 'Discover, publish, price, and manage tools plus dashboard-ready cards',
    welcome: {
      greeting: 'I\'m your marketplace specialist. I can find tools and dashboard-ready cards for any task, help you publish and price your own, or analyze what\'s trending. What are you looking for?',
      starters: [
        { label: 'Browse popular tools', prompt: 'Show me the most popular tools on the marketplace right now' },
        { label: 'Find dashboard cards', prompt: 'Find dashboard-ready Command cards for my workflow' },
        { label: 'Find tools for a task', prompt: 'What tools are available for managing email and calendar?' },
        { label: 'Publish my app', prompt: 'Help me publish my app to the marketplace and set pricing' },
        { label: 'Check my tool analytics', prompt: 'Show me analytics and earnings for my published tools' },
      ],
    },
  },
  {
    type: 'platform_manager',
    name: 'Platform Guide',
    role: 'manager',
    icon: 'Settings',
    persona: 'Platform Guide, a platform concierge who manages settings, billing, Command dashboards, and guides users',
    skillsPath: 'system-agents/platform_manager/skills.md',
    description: 'Settings, API keys, billing, Command dashboards, and platform guidance',
    welcome: {
      greeting: 'I\'m here to help you get the most out of Ultralight. Ask me about settings, billing, API keys, Command dashboards, or how anything on the platform works.',
      starters: [
        { label: 'How does Light work?', prompt: 'How does the Light currency system work and how do I earn or spend it?' },
        { label: 'Set up Command', prompt: 'Help me set up a Command dashboard for my work and personal workflows' },
        { label: 'Set up my first app', prompt: 'Walk me through setting up and using my first app on Ultralight' },
        { label: 'Check my balance & usage', prompt: 'Show me my current Light balance and recent usage breakdown' },
        { label: 'Manage my API key', prompt: 'Help me manage my API key and connected services' },
      ],
    },
  },
];

/**
 * Generate a deterministic ID for a system agent.
 * Uses a simple hash of userId + type to ensure idempotent provisioning.
 */
export async function deriveSystemAgentId(userId: string, agentType: string): Promise<string> {
  const data = new TextEncoder().encode(`${userId}:system:${agentType}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  // Format as UUID-like: 8-4-4-4-12
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
