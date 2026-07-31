export const AUTH_FUNNEL_PLAN_STORAGE_KEY =
  "galactic:auth-funnel:agent-plan:v1";

export const AUTH_FUNNEL_PLAN_VERSION = 1 as const;
export const AUTH_FUNNEL_PLAN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const AUTH_FUNNEL_NAME_MAX_LENGTH = 80;
// Keep the fully assembled, server-bound handoff description comfortably
// below the API's 4,000-character ceiling even when every field is full.
export const AUTH_FUNNEL_BRIEF_MAX_LENGTH = 1_400;
export const AUTH_FUNNEL_NOTE_MAX_LENGTH = 240;

export type AuthFunnelFeatureKey =
  | "routines"
  | "database"
  | "interfaces"
  | "functions"
  | "vm"
  | "inference";

export type AuthFunnelQuestionKey = "brief" | AuthFunnelFeatureKey;

export interface AuthFunnelOption {
  id: string;
  label: string;
  prompt: string;
}

export interface AuthFunnelFeature {
  ballot: string;
  hint: string;
  key: AuthFunnelFeatureKey;
  options: readonly AuthFunnelOption[];
  row: string;
  short: string;
  tag: string;
}

export interface AuthFunnelPlan {
  agentName: string;
  answers: Partial<Record<AuthFunnelFeatureKey, string>>;
  brief: string;
  hasCopied: boolean;
  notes: Partial<Record<AuthFunnelFeatureKey, string>>;
  open: AuthFunnelQuestionKey | null;
  reviewUnlocked: boolean;
  updatedAt: string;
  version: typeof AUTH_FUNNEL_PLAN_VERSION;
}

export interface AuthFunnelManifestRow {
  deciding: boolean;
  key: AuthFunnelFeatureKey;
  label: string;
  value: string;
}

export const AUTH_FUNNEL_FEATURES: readonly AuthFunnelFeature[] = [
  {
    ballot: "Wake on a schedule",
    hint:
      "Runs on its own clock — hourly sweeps, daily digests — without being asked.",
    key: "routines",
    options: [
      {
        id: "every-morning",
        label: "Every morning",
        prompt: "wakes every morning",
      },
      {
        id: "few-times-daily",
        label: "A few times a day",
        prompt: "wakes a few times a day",
      },
      {
        id: "weekly",
        label: "Once a week",
        prompt: "wakes once a week",
      },
      {
        id: "on-demand",
        label: "Only when I ask",
        prompt: "runs only when I ask",
      },
    ],
    row: "Routines",
    short: "Schedule",
    tag: "Routines",
  },
  {
    ballot: "Keep records",
    hint:
      "Remembers things between runs — what it saw, what it did, what is pending.",
    key: "database",
    options: [
      {
        id: "working-memory",
        label: "A working memory",
        prompt: "keeps a working memory",
      },
      { id: "logs-only", label: "Logs only", prompt: "keeps logs only" },
      { id: "no-records", label: "No records", prompt: "keeps no records" },
    ],
    row: "Database",
    short: "Records",
    tag: "Database",
  },
  {
    ballot: "Show pages to humans",
    hint:
      "A focused page for you or your team to review work, answer questions, or see status.",
    key: "interfaces",
    options: [
      {
        id: "private-page",
        label: "A page just for me",
        prompt: "shows a private page just for me",
      },
      {
        id: "team-pages",
        label: "Pages my team opens",
        prompt: "shows pages my team can open",
      },
      {
        id: "no-pages",
        label: "No pages",
        prompt: "needs no human-facing pages",
      },
    ],
    row: "Interfaces",
    short: "Pages",
    tag: "Interfaces",
  },
  {
    ballot: "Take actions",
    hint:
      "The things it can do beyond thinking — look things up, change records, or act outside Galactic.",
    key: "functions",
    options: [
      {
        id: "read-write",
        label: "Read and write",
        prompt: "reads and writes for real",
      },
      {
        id: "read-only",
        label: "Read only, to start",
        prompt: "starts read-only",
      },
      { id: "no-actions", label: "No actions", prompt: "takes no actions" },
    ],
    row: "Functions",
    short: "Actions",
    tag: "Functions",
  },
  {
    ballot: "Run heavier compute",
    hint:
      "A virtual machine for browser work, files, data processing, or long scripts.",
    key: "vm",
    options: [
      {
        id: "ready-on-call",
        label: "Ready on call",
        prompt: "gets a virtual machine ready on call",
      },
      {
        id: "probably-not",
        label: "Probably not",
        prompt: "probably needs no virtual machine",
      },
    ],
    row: "Virtual machine",
    short: "Compute",
    tag: "Virtual machine",
  },
  {
    ballot: "Call AI on your key",
    hint:
      "Judgment calls — drafting and triage — use your provider key without a Galactic markup.",
    key: "inference",
    options: [
      {
        id: "byok",
        label: "Yes, on my key",
        prompt: "calls AI on my key",
      },
      {
        id: "rules-only",
        label: "No — rules only",
        prompt: "makes no AI calls, using rules only",
      },
    ],
    row: "Inference",
    short: "AI calls",
    tag: "Inference",
  },
] as const;

const FEATURE_BY_KEY = new Map(
  AUTH_FUNNEL_FEATURES.map((feature) => [feature.key, feature]),
);
const QUESTION_ORDER: readonly AuthFunnelQuestionKey[] = [
  "brief",
  ...AUTH_FUNNEL_FEATURES.map((feature) => feature.key),
];

export function createAuthFunnelPlan(
  now = new Date().toISOString(),
): AuthFunnelPlan {
  return {
    agentName: "",
    answers: {},
    brief: "",
    hasCopied: false,
    notes: {},
    open: "brief",
    reviewUnlocked: false,
    updatedAt: now,
    version: AUTH_FUNNEL_PLAN_VERSION,
  };
}

export function readAuthFunnelPlan(
  storage: Pick<Storage, "getItem"> | null,
  now = Date.now(),
): AuthFunnelPlan {
  try {
    const raw = storage?.getItem(AUTH_FUNNEL_PLAN_STORAGE_KEY);
    if (!raw) return createAuthFunnelPlan(new Date(now).toISOString());
    return normalizeAuthFunnelPlan(JSON.parse(raw), now);
  } catch {
    return createAuthFunnelPlan(new Date(now).toISOString());
  }
}

export function writeAuthFunnelPlan(
  storage: Pick<Storage, "setItem"> | null,
  plan: AuthFunnelPlan,
): void {
  try {
    storage?.setItem(AUTH_FUNNEL_PLAN_STORAGE_KEY, JSON.stringify(plan));
  } catch {
    // The in-memory plan remains fully usable when browser storage is blocked.
  }
}

export function normalizeAuthFunnelPlan(
  value: unknown,
  now = Date.now(),
): AuthFunnelPlan {
  const fallback = createAuthFunnelPlan(new Date(now).toISOString());
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const record = value as Record<string, unknown>;
  const updatedAt = typeof record.updatedAt === "string"
    ? Date.parse(record.updatedAt)
    : Number.NaN;
  if (
    record.version !== AUTH_FUNNEL_PLAN_VERSION ||
    !Number.isFinite(updatedAt) ||
    updatedAt > now + 60_000 ||
    now - updatedAt > AUTH_FUNNEL_PLAN_MAX_AGE_MS
  ) {
    return fallback;
  }

  const answers: AuthFunnelPlan["answers"] = {};
  const notes: AuthFunnelPlan["notes"] = {};
  const rawAnswers = objectRecord(record.answers);
  const rawNotes = objectRecord(record.notes);
  for (const feature of AUTH_FUNNEL_FEATURES) {
    const answer = rawAnswers[feature.key];
    if (
      typeof answer === "string" &&
      feature.options.some((option) => option.id === answer)
    ) {
      answers[feature.key] = answer;
    }
    const note = rawNotes[feature.key];
    if (typeof note === "string") {
      notes[feature.key] = note.slice(0, AUTH_FUNNEL_NOTE_MAX_LENGTH);
    }
  }

  return {
    agentName: stringValue(record.agentName).slice(
      0,
      AUTH_FUNNEL_NAME_MAX_LENGTH,
    ),
    answers,
    brief: stringValue(record.brief).slice(0, AUTH_FUNNEL_BRIEF_MAX_LENGTH),
    hasCopied: record.hasCopied === true,
    notes,
    open: isQuestionKey(record.open) ? record.open : null,
    reviewUnlocked: record.reviewUnlocked === true,
    updatedAt: new Date(updatedAt).toISOString(),
    version: AUTH_FUNNEL_PLAN_VERSION,
  };
}

export function authFunnelDisplayName(plan: AuthFunnelPlan): string {
  return plan.agentName.trim() || "Untitled Agent";
}

export function authFunnelManifestRows(
  plan: AuthFunnelPlan,
): AuthFunnelManifestRow[] {
  return AUTH_FUNNEL_FEATURES.map((feature) => {
    const option = selectedAuthFunnelOption(plan, feature.key);
    const deciding = plan.open === feature.key;
    return {
      deciding,
      key: feature.key,
      label: feature.row,
      value: option?.label ?? (deciding ? "deciding…" : "—"),
    };
  });
}

export function authFunnelQuestionAnswered(
  plan: AuthFunnelPlan,
  key: AuthFunnelQuestionKey,
): boolean {
  if (key === "brief") return plan.brief.trim().length > 0;
  return Boolean(
    selectedAuthFunnelOption(plan, key) || plan.notes[key]?.trim(),
  );
}

export function authFunnelQuestionSummary(
  plan: AuthFunnelPlan,
  key: AuthFunnelQuestionKey,
): string {
  if (key === "brief") {
    return quoteAndTruncate(plan.brief.trim(), 64);
  }
  const parts: string[] = [];
  const option = selectedAuthFunnelOption(plan, key);
  if (option) parts.push(option.label);
  const note = plan.notes[key]?.trim();
  if (note) parts.push(quoteAndTruncate(note, 40));
  return parts.join(" · ");
}

export function nextAuthFunnelQuestion(
  key: AuthFunnelQuestionKey,
): AuthFunnelQuestionKey | null {
  const index = QUESTION_ORDER.indexOf(key);
  return index >= 0 && index < QUESTION_ORDER.length - 1
    ? QUESTION_ORDER[index + 1] ?? null
    : null;
}

export function selectedAuthFunnelOption(
  plan: AuthFunnelPlan,
  key: AuthFunnelFeatureKey,
): AuthFunnelOption | null {
  const feature = FEATURE_BY_KEY.get(key);
  const selected = plan.answers[key];
  return feature?.options.find((option) => option.id === selected) ?? null;
}

/**
 * This is both the human-readable plan in the copied prompt and the
 * description hash bound to the purpose-limited handoff session.
 */
export function buildAuthFunnelPlanDescription(
  plan: AuthFunnelPlan,
): string {
  const name = plan.agentName.trim();
  const preface = name
    ? `Call it "${singleLine(name)}".`
    : "Pick it a short name once you understand the job.";
  const realAnswers = [
    plan.brief.trim(),
    ...AUTH_FUNNEL_FEATURES.flatMap((feature) => [
      plan.answers[feature.key] ?? "",
      plan.notes[feature.key]?.trim() ?? "",
    ]),
  ].some(Boolean);

  if (!realAnswers) {
    return [
      preface,
      "",
      "I skipped the questionnaire. Propose a manifest, explain it in plain words, and check it with me before you build.",
    ].join("\n");
  }

  const lines = [
    `- Job: ${
      plan.brief.trim()
        ? singleLine(plan.brief.trim())
        : "your call — ask me in chat"
    }`,
    ...AUTH_FUNNEL_FEATURES.map((feature) => {
      const selected = selectedAuthFunnelOption(plan, feature.key);
      const note = plan.notes[feature.key]?.trim();
      let value = selected?.prompt ?? "your call";
      if (!selected && note) value = `your call (${quoted(singleLine(note))})`;
      else if (note) value += ` (${quoted(singleLine(note))})`;
      return `- ${feature.short}: ${value}`;
    }),
  ];

  return [
    preface,
    "",
    "What I planned on Galactic:",
    ...lines,
  ].join("\n");
}

function isQuestionKey(value: unknown): value is AuthFunnelQuestionKey {
  return typeof value === "string" &&
    QUESTION_ORDER.includes(value as AuthFunnelQuestionKey);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function quoteAndTruncate(value: string, maxLength: number): string {
  if (!value) return "";
  const truncated = value.length > maxLength
    ? `${value.slice(0, maxLength - 1)}…`
    : value;
  return quoted(truncated);
}

function quoted(value: string): string {
  return `“${value}”`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
