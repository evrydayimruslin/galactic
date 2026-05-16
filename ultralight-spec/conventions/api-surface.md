# API Surface

Access the SDK via `globalThis.ultralight` (available as `ultralight` in app code).

## Database methods

### ultralight.db.run(sql, params?)

Execute INSERT, UPDATE, or DELETE.

```ts
const result = await ultralight.db.run(
  "INSERT INTO tasks (id, user_id, title) VALUES (?, ?, ?)",
  [crypto.randomUUID(), ultralight.user.id, "Buy groceries"]
);
// result: { success: true, meta: { changes: 1, last_row_id: 1, duration: 0.5, rows_read: 0, rows_written: 1 } }
```

### ultralight.db.all<T>(sql, params?)

SELECT all matching rows.

```ts
const tasks = await ultralight.db.all<Task>(
  "SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC",
  [ultralight.user.id]
);
// returns: Task[]
```

### ultralight.db.first<T>(sql, params?)

SELECT the first matching row.

```ts
const task = await ultralight.db.first<Task>(
  "SELECT * FROM tasks WHERE id = ? AND user_id = ?",
  [taskId, ultralight.user.id]
);
// returns: Task | null
```

### ultralight.db.batch(statements)

Execute multiple statements sequentially.

> **Important**: Batch is currently executed as sequential individual queries via the
> D1 REST API. Statements are **not** wrapped in a database transaction — if statement
> 3 of 5 fails, statements 1-2 are already committed. Design your batch operations
> to be **idempotent** (see patterns below).

```ts
const results = await ultralight.db.batch([
  { sql: "UPDATE tasks SET status = ? WHERE id = ? AND user_id = ?", params: ["done", id1, ultralight.user.id] },
  { sql: "UPDATE tasks SET status = ? WHERE id = ? AND user_id = ?", params: ["done", id2, ultralight.user.id] },
]);
// returns: D1RunResult[]
```

**Idempotent batch patterns** (safe for partial failures):

```ts
// ✅ INSERT OR IGNORE — safe to re-run
{ sql: "INSERT OR IGNORE INTO items (id, user_id, name) VALUES (?, ?, ?)", params: [...] }

// ✅ Check-before-write — verify state before mutating
const existing = await ultralight.db.first("SELECT status FROM orders WHERE id = ? AND user_id = ?", [id, uid]);
if (existing?.status !== 'completed') {
  await ultralight.db.run("UPDATE orders SET status = 'completed' WHERE id = ? AND user_id = ?", [id, uid]);
}

// ✅ Upsert — ON CONFLICT handles re-runs
{ sql: "INSERT INTO counters (id, user_id, count) VALUES (?, ?, 1) ON CONFLICT(id) DO UPDATE SET count = count + 1", params: [...] }
```

### ultralight.db.exec(sql)

**BLOCKED at runtime.** Only available during migrations. Attempting to call `exec()` in app code will throw.

## Function signature conventions

All exported functions receive a single `args` object. Always default it to `{}` to handle
cases where the MCP handler passes no arguments:

```ts
export async function my_function(args: {
  name?: string;
  count?: number;
} = {}): Promise<unknown> {
  const { name, count } = args;
  // ...
}
```

> **Why**: The platform always passes an args object, but defaulting to `{}` provides
> defense-in-depth against destructuring errors.

## Parameter naming conventions

Parameter names appear in the MCP tool schema that agents use to call functions. Agents have **no access to source code** — they rely entirely on the schema's parameter names, types, and descriptions. Every parameter must be self-documenting.

### Rules for parameter names

1. **Use the most precise unambiguous name.** Prefer names that tell the agent what format to provide. Use `sql` for SQL strings (not `query`, which could mean natural language). Use `id` instead of `item_identifier`. Use `query` only for free-text/semantic search parameters.
2. **Add a `description` for every parameter** in manifest.json. The description appears in `tools/list` and is the agent's only hint for ambiguous parameters.
3. **Use `_id` suffix for foreign keys.** `product_id`, `reservation_id`, `equipment_id` — not `product`, `reservation`, `item`.
4. **Use `_date` / `_time` suffix for temporal values.** `check_in_date`, `tee_time` — not `check_in` (ambiguous: is it a date or a boolean?).
5. **Use consistent naming across functions.** If `rooms_book` uses `guest_name`, then `ski_rent`, `golf_book_tee`, and `restaurant_book` must also use `guest_name` — not `name`, `customer`, or `guest`.

### Manifest parameter format

Parameters in `manifest.json` must be an **object keyed by parameter name** (not an array):

```json
{
  "functions": {
    "search": {
      "description": "Search for items",
      "parameters": {
        "query": { "type": "string", "required": true, "description": "Search query text" },
        "limit": { "type": "number", "required": false, "description": "Max results (default 10)" }
      }
    }
  }
}
```

**Do not** use the array format `[{ "name": "query", "type": "string" }]`. The platform normalizes arrays to objects, but object-keyed format is canonical and ensures correct schema delivery to agents.

## Direct HTTP routes

Functions are MCP-callable by default. To expose a function as a direct HTTP
endpoint, declare it in `manifest.json` under `http.routes`:

```json
{
  "functions": {
    "webhook": {
      "description": "Receive provider webhooks"
    }
  },
  "http": {
    "routes": {
      "webhook": {
        "auth": "public",
        "methods": ["POST"],
        "cors": {
          "origins": ["https://provider.example"]
        },
        "rate_limit": {
          "rpm": 60
        }
      }
    }
  }
}
```

Route URL:

```text
POST /http/{appId}/webhook
```

Public HTTP routes:

1. Must declare at least one method.
2. Must use owner billing.
3. Must use app data scope.
4. Do not require an Ultralight `Authorization` header.
5. May still receive third-party `Authorization` or signature headers; validate
   those inside the function when integrating with webhook providers.

Authenticated HTTP routes use `"auth": "user"` and require
`Authorization: Bearer {TOKEN}`. Use `"data_scope": "user"` only for
authenticated routes that must partition app data by the calling user.

## Rules

1. **Always parameterize.** Use `?` placeholders. Never string-interpolate values into SQL.
2. **Always include user_id.** Every query must filter by `user_id` (see user-isolation.md).
3. **Use `crypto.randomUUID()` for IDs.** Generate IDs client-side, not with autoincrement.
4. **Use `ultralight.user.id`** to get the current authenticated user's ID.
5. **Design batch operations for idempotency.** Use `INSERT OR IGNORE`, `ON CONFLICT`, or check-before-write patterns since batch is not transactional.
6. **Every parameter must have a description.** Agents cannot read your source code. The manifest description is their only documentation.
