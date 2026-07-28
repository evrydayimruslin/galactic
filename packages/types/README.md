# @ultralightpro/types

TypeScript type definitions for [Galactic](https://ultralight.dev) apps.

`index.d.ts` and the `generated/` declarations are generated artifacts. Update
the shared contract sources under `/shared/contracts` and then run
`npm run generate` in `/packages/types`.

Provides autocomplete and type checking for `galactic.ai()`,
`galactic.store()`, and all runtime SDK methods. `ultralight` remains a
compatible global alias.

## Installation

```bash
npm install -D @ultralightpro/types
```

## Usage

Add a reference at the top of your entry file:

```typescript
/// <reference types="@ultralightpro/types" />

export async function hello(name: string) {
  // Now you get autocomplete for ultralight!
  await ultralight.store('greetings', { name, time: Date.now() });
  return `Hello, ${name}!`;
}
```

Or add to your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "types": ["@ultralightpro/types"]
  }
}
```

## What's Available

The `ultralight` global provides:

### Data Storage
```typescript
await ultralight.store('key', value);
await ultralight.load('key');
await ultralight.list('prefix/');
await ultralight.query('prefix/', { limit: 10, sort: { field: 'date', order: 'desc' } });
```

### AI (BYOK or platform credits)
```typescript
const response = await galactic.ai({
  messages: [{ role: 'user', content: 'Hello!' }],
  temperature: 0.7,
});
console.log(response.content);
```

Use `output_schema` when the result is data rather than prose. Galactic sends
the JSON Schema through the provider's native strict-output mechanism and
validates the returned value again before exposing `response.output`:

```typescript
interface Invoice {
  id: string;
  total: number;
}

const response = await galactic.ai<Invoice>({
  messages: [{ role: 'user', content: 'Extract invoice INV-42 for $125.' }],
  output_schema: {
    name: 'invoice',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        total: { type: 'number' },
      },
      required: ['id', 'total'],
      additionalProperties: false,
    },
  },
});

const invoice = response.output;
```

Structured-output failures use the typed codes
`invalid_output_schema`, `structured_output_unsupported`,
`structured_output_invalid_json`, and
`structured_output_schema_mismatch`. Galactic does not silently fall back to a
“return JSON” prompt. `usage.input_tokens` and `usage.output_tokens` are the
provider-reported counts; credit cost is estimated from those counts and the
platform model-price table.

Galactic accepts a bounded, locally enforced JSON Schema subset and rejects
unknown assertions before inference. It supports composition, types,
const/enum, string lengths, numeric bounds, array items/limits/uniqueness,
object properties/required/additional properties, and acyclic local
`$ref`/definitions. `pattern`, `format`, `contains`, conditional schemas,
remote references, and recursive references are not accepted. See
[Builder Milestone 1](../../docs/BUILDER_MILESTONE_1.md) for the exact keyword
list and limits. Provider work is charged or recorded before final local
validation, so a schema mismatch still settles completed inference usage.

### User Context
```typescript
if (ultralight.isAuthenticated()) {
  const user = ultralight.user;
  console.log(user.email);
}
```

## Global Utilities

These are also available globally:

- `_` - Lodash-like utilities (groupBy, chunk, sortBy, etc.)
- `uuid.v4()` - UUID generation
- `base64.encode()` / `base64.decode()`
- `hash.sha256()` / `hash.sha512()`
- `dateFns.format()` - Date formatting

## React Apps

For UI apps, export a default function:

```tsx
/// <reference types="@ultralightpro/types" />
import React from 'react';
import ReactDOM from 'react-dom/client';

const App: UltralightApp = (container, sdk) => {
  const root = ReactDOM.createRoot(container);
  root.render(<MyApp sdk={sdk} />);
};

export default App;
```

## Links

- [Galactic Documentation](https://ultralight.dev/docs)
- [GitHub](https://github.com/evrydayimruslin/ultralight)
