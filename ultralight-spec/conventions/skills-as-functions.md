# Skills As Functions

Skills are not a platform primitive. An Agent that wants to ship long-form
context (playbooks, domain guides, reference material) exposes it through
ordinary exported functions, priced and permissioned like any other function.

## The convention

Export two functions:

```typescript
// Lists the skills this Agent offers. Keep descriptions short — they are
// what callers (and discovery) see before paying for the full text.
export function skills_index(args: {}) {
  return {
    skills: [
      {
        id: "email-deliverability",
        name: "Email Deliverability Playbook",
        description: "DNS, warm-up, and reputation triage for cold outbound.",
      },
    ],
  };
}

// Returns the full text of one skill.
export function skill_reader(args: { skill_id: string }) {
  return {
    id: args.skill_id,
    content: "# Email Deliverability Playbook\n...full markdown...",
    format: "markdown",
  };
}
```

Rules:

- Function names `skills_index` and `skill_reader` are the convention; ship
  both or neither. The index must be callable with empty args.
- `skills_index` returns `{ skills: [{ id, name, description }] }`. Keep it
  free (no per-call price) so callers can browse before buying.
- `skill_reader` takes `{ skill_id }` and returns
  `{ id, content, format: "markdown" }`. Price it with standard per-function
  pricing — `ul.set({ function_prices: { skill_reader: ... } })`, stored as
  `pricing_config.functions.skill_reader` — and grant free calls via
  `free_calls` if you want a preview allowance.
- Store skill bodies however you like — inline strings, `ultralight.store`,
  or bundled data. The platform does not interpret them.

## What this replaces

Earlier platform versions had first-class manifest `skills{}` entries with a
dedicated paid "skill pull" flow. That surface is retired: declaring
`skills` in `manifest.json` is still accepted but is no longer surfaced or
billed by the platform. Use the functions above instead.

Generated `skills.md` (the per-app function documentation built at deploy
time) is unrelated to this convention: it remains automatic and is always
served free from the Agent's MCP endpoint.
