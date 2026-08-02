import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";

import { CapabilityError } from "../../../shared/contracts/capabilities.ts";
import { conceptsCapability } from "./concepts.ts";

const ctx = (over: Record<string, unknown> = {}) =>
  ({
    userId: "user-1",
    provisional: false,
    authSource: "supabase",
    ...over,
    // deno-lint-ignore no-explicit-any
  }) as any;

const deps = {
  resolveApp: (userId: string, ref: string) => {
    if (ref !== "agent-1") {
      throw new CapabilityError("not_found", `Agent not found: ${ref}`);
    }
    return Promise.resolve({ id: "app-1", owner_id: userId });
  },
};

Deno.test("gx.concepts: provisional and unknown auth sources are refused", async () => {
  await assertRejects(
    () => conceptsCapability({ agent_id: "agent-1" }, ctx({ provisional: true }), deps),
    CapabilityError,
    "authenticated",
  );
  await assertRejects(
    () =>
      conceptsCapability(
        { agent_id: "agent-1" },
        ctx({ authSource: "routine_actor" }),
        deps,
      ),
    CapabilityError,
    "authenticated",
  );
});

Deno.test("gx.concepts: builder_handoff sessions may read and describe (agent-attributed)", async () => {
  let described: Record<string, unknown> | null = null;
  const result = await conceptsCapability(
    {
      action: "describe",
      agent_id: "agent-1",
      slug: "refund-window",
      description: "Money-back rules.",
    },
    ctx({ authSource: "builder_handoff" }),
    {
      ...deps,
      // deno-lint-ignore no-explicit-any
      describe: ((_u: string, _a: string, _s: string, input: any) => {
        described = input;
        return Promise.resolve({ slug: "refund-window" });
        // deno-lint-ignore no-explicit-any
      }) as any,
    },
  ) as { concept: { slug: string } };
  assertEquals(result.concept.slug, "refund-window");
  assert(described);
  assertEquals((described as Record<string, unknown>).author, "agent");
});

Deno.test("gx.concepts: account sessions describe as owner", async () => {
  let author = "";
  await conceptsCapability(
    { action: "describe", agent_id: "agent-1", slug: "s-1", description: "x" },
    ctx(),
    {
      ...deps,
      // deno-lint-ignore no-explicit-any
      describe: ((_u: string, _a: string, _s: string, input: any) => {
        author = input.author;
        return Promise.resolve({ slug: "s-1" });
        // deno-lint-ignore no-explicit-any
      }) as any,
    },
  );
  assertEquals(author, "owner");
});

Deno.test("gx.concepts: list defaults, about 404s helpfully, suggest requires text", async () => {
  const listed = await conceptsCapability(
    { agent_id: "agent-1" },
    ctx(),
    // deno-lint-ignore no-explicit-any
    { ...deps, list: (() => Promise.resolve([])) as any },
  ) as { concepts: unknown[] };
  assertEquals(listed.concepts, []);

  await assertRejects(
    () =>
      conceptsCapability(
        { action: "about", agent_id: "agent-1", slug: "ghost" },
        ctx(),
        // deno-lint-ignore no-explicit-any
        { ...deps, about: (() => Promise.resolve(null)) as any },
      ),
    CapabilityError,
    "Writing [[slug]] anywhere creates it",
  );

  await assertRejects(
    () =>
      conceptsCapability(
        { action: "suggest", agent_id: "agent-1" },
        ctx(),
        deps,
      ),
    CapabilityError,
    "text is required",
  );
});

Deno.test("gx.concepts: ownership is the authorization", async () => {
  await assertRejects(
    () => conceptsCapability({ agent_id: "not-mine" }, ctx(), deps),
    CapabilityError,
    "Agent not found",
  );
});
