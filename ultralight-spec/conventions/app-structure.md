# App Structure

## Files

| File | Required | Purpose |
|------|----------|---------|
| `index.ts` | Yes | App entry point. Export async functions. |
| `manifest.json` | No | App metadata, permissions, description |
| `migrations/` | No | SQL migration files (see migrations.md) |
| `test_fixture.json` | No | Test data for local development |
| `ultralight.gpu.yaml` | No | Reserved GPU pipeline config; uploads are blocked unless `GPU_SUPPORT_ENABLED=true` |

## Function signature

Every exported function follows the single-args-object pattern:

```ts
export async function createTask(args: {
  title: string;
  priority?: number;
}): Promise<unknown> {
  const { title, priority = 0 } = args;
  // ...
}
```

- Single `args` object (not positional parameters).
- Return type is `Promise<unknown>` (or a more specific type).
- Each exported async function becomes a callable tool/endpoint.

## SDK access

Access the Ultralight SDK via `globalThis.ultralight`:

```ts
const userId = ultralight.user.id;
const rows = await ultralight.db.all("SELECT ...", [...]);
```

Do not import ultralight — it is injected as a global.

## Runtime environment

- App code runs in a **Deno sandbox**.
- `fetch()` is available (requires `net:fetch` permission in manifest).
- No filesystem access. No child processes. No dynamic imports from URLs.
