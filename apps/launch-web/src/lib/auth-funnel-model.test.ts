import { describe, expect, it } from "vitest";

import {
  AUTH_FUNNEL_BRIEF_MAX_LENGTH,
  AUTH_FUNNEL_FEATURES,
  AUTH_FUNNEL_NAME_MAX_LENGTH,
  AUTH_FUNNEL_NOTE_MAX_LENGTH,
  AUTH_FUNNEL_PLAN_STORAGE_KEY,
  authFunnelManifestRows,
  authFunnelQuestionAnswered,
  authFunnelQuestionSummary,
  buildAuthFunnelPlanDescription,
  createAuthFunnelPlan,
  nextAuthFunnelQuestion,
  normalizeAuthFunnelPlan,
  readAuthFunnelPlan,
  writeAuthFunnelPlan,
} from "./auth-funnel-model";

describe("auth funnel planning model", () => {
  it("locks the seven-question order and canonical six-row manifest order", () => {
    expect(AUTH_FUNNEL_FEATURES.map((feature) => feature.ballot)).toEqual([
      "Wake on a schedule",
      "Keep records",
      "Show pages to humans",
      "Take actions",
      "Run heavier compute",
      "Call AI on your key",
    ]);
    expect(
      authFunnelManifestRows(createAuthFunnelPlan()).map((row) => row.label),
    ).toEqual([
      "Routines",
      "Database",
      "Interfaces",
      "Functions",
      "Virtual machine",
      "Inference",
    ]);
    expect(nextAuthFunnelQuestion("brief")).toBe("routines");
    expect(nextAuthFunnelQuestion("routines")).toBe("database");
    expect(nextAuthFunnelQuestion("inference")).toBeNull();
  });

  it("shows only verbatim selected chip labels in the manifest", () => {
    const plan = {
      ...createAuthFunnelPlan(),
      answers: {
        routines: "every-morning",
        functions: "read-only",
      },
      notes: {
        routines: "Only on weekdays at 08:30",
        database: "Keep 90 days",
      },
      open: "interfaces" as const,
    };

    expect(authFunnelManifestRows(plan).map((row) => row.value)).toEqual([
      "Every morning",
      "—",
      "deciding…",
      "Read only, to start",
      "—",
      "—",
    ]);
    expect(authFunnelQuestionAnswered(plan, "database")).toBe(true);
    expect(authFunnelQuestionSummary(plan, "routines")).toContain(
      "Every morning · “Only on weekdays",
    );
  });

  it("writes notes into the prompt but never invents planning-manifest values", () => {
    const plan = {
      ...createAuthFunnelPlan(),
      agentName: "inbox-keeper",
      brief: "Draft replies for review",
      answers: {
        database: "working-memory",
        functions: "read-write",
      },
      notes: {
        database: "keep 90 days",
        interfaces: "mobile first",
      },
    };
    const prompt = buildAuthFunnelPlanDescription(plan);

    expect(prompt).toContain('Call it "inbox-keeper".');
    expect(prompt).toContain("- Job: Draft replies for review");
    expect(prompt).toContain(
      "- Records: keeps a working memory (“keep 90 days”)",
    );
    expect(prompt).toContain(
      "- Pages: your call (“mobile first”)",
    );
    expect(prompt).toContain("- Actions: reads and writes for real");
    expect(authFunnelManifestRows(plan)[1]?.value).toBe("A working memory");
    expect(authFunnelManifestRows(plan)[2]?.value).toBe("—");
  });

  it("keeps the all-skipped path valid and asks the coding agent to propose", () => {
    const description = buildAuthFunnelPlanDescription(
      createAuthFunnelPlan(),
    );
    expect(description).toContain(
      "Pick it a short name once you understand the job.",
    );
    expect(description).toContain("I skipped the questionnaire.");
    expect(description).not.toContain("What I planned on Galactic:");
  });

  it("normalizes untrusted cross-tab storage and expires old drafts", () => {
    const now = Date.parse("2026-07-30T20:00:00.000Z");
    const normalized = normalizeAuthFunnelPlan({
      version: 1,
      updatedAt: "2026-07-30T19:59:00.000Z",
      agentName: "a".repeat(200),
      brief: "b".repeat(2_000),
      answers: {
        routines: "every-morning",
        database: "not-a-real-option",
      },
      notes: { routines: "n".repeat(500) },
      open: "not-a-question",
      hasCopied: true,
      reviewUnlocked: true,
    }, now);
    expect(normalized.agentName).toHaveLength(AUTH_FUNNEL_NAME_MAX_LENGTH);
    expect(normalized.brief).toHaveLength(AUTH_FUNNEL_BRIEF_MAX_LENGTH);
    expect(normalized.notes.routines).toHaveLength(
      AUTH_FUNNEL_NOTE_MAX_LENGTH,
    );
    expect(normalized.answers).toEqual({ routines: "every-morning" });
    expect(normalized.open).toBeNull();

    const expired = normalizeAuthFunnelPlan({
      ...normalized,
      updatedAt: "2026-06-01T00:00:00.000Z",
    }, now);
    expect(expired).toMatchObject({
      agentName: "",
      hasCopied: false,
      open: "brief",
      reviewUnlocked: false,
    });
  });

  it("persists only non-secret plan state in shared browser storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const plan = {
      ...createAuthFunnelPlan("2026-07-30T20:00:00.000Z"),
      brief: "Triage support",
    };
    writeAuthFunnelPlan(storage, plan);

    expect(values.has(AUTH_FUNNEL_PLAN_STORAGE_KEY)).toBe(true);
    expect(values.get(AUTH_FUNNEL_PLAN_STORAGE_KEY)).not.toContain("gx_");
    expect(
      readAuthFunnelPlan(
        storage,
        Date.parse("2026-07-30T20:01:00.000Z"),
      ).brief,
    ).toBe("Triage support");
  });

  it("cannot exceed the server handoff description ceiling at field maxima", () => {
    const plan = {
      ...createAuthFunnelPlan(),
      agentName: "a".repeat(AUTH_FUNNEL_NAME_MAX_LENGTH),
      brief: "b".repeat(AUTH_FUNNEL_BRIEF_MAX_LENGTH),
      notes: Object.fromEntries(
        AUTH_FUNNEL_FEATURES.map((feature) => [
          feature.key,
          "n".repeat(AUTH_FUNNEL_NOTE_MAX_LENGTH),
        ]),
      ),
    };
    expect(buildAuthFunnelPlanDescription(plan).length).toBeLessThanOrEqual(
      4_000,
    );
  });
});
