# @ultralightpro/types

TypeScript type definitions for [Ultralight](https://ultralight.dev) apps.

`index.d.ts` and the `generated/` declarations are generated artifacts. Update
the shared contract sources under `/shared/contracts` and then run
`npm run generate` in `/packages/types`.

Provides autocomplete and type checking for `ultralight.ai()`, `ultralight.store()`, and all SDK methods.

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

### AI (BYOK Or Light)
```typescript
const response = await ultralight.ai({
  messages: [{ role: 'user', content: 'Hello!' }],
  temperature: 0.7,
});
console.log(response.content);
```

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

- [Ultralight Documentation](https://ultralight.dev/docs)
- [GitHub](https://github.com/evrydayimruslin/ultralight)
