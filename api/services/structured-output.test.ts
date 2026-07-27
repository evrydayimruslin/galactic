import { assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert';
import type { AIOutputSchema } from '../../shared/contracts/ai.ts';
import { AIProviderError, buildAIProviderRequestBody, createAIService } from './ai.ts';
import type { ResolvedInferenceRoute } from './inference-route.ts';
import { createRoutedRuntimeAIService } from './runtime-ai.ts';
import {
  applyStructuredOutput,
  isStructuredOutputUnsupportedProviderError,
  normalizeOutputSchema,
  parseStructuredOutput,
  StructuredOutputError,
} from './structured-output.ts';

const invoiceSchema = {
  name: 'invoice',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      invoice_id: { type: 'string', minLength: 1 },
      total: { type: 'number', minimum: 0 },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            quantity: { type: 'integer', minimum: 1 },
          },
          required: ['description', 'quantity'],
          additionalProperties: false,
        },
      },
    },
    required: ['invoice_id', 'total', 'lines'],
    additionalProperties: false,
  },
};

function route(): ResolvedInferenceRoute {
  return {
    billingMode: 'byok',
    provider: 'deepseek',
    upstreamProvider: 'deepseek',
    baseUrl: 'https://provider.test',
    apiKey: 'key',
    model: 'deepseek-v4-pro',
    keySource: 'user_byok',
    billingSource: 'none',
    shouldRequireBalance: false,
    shouldDebitLight: false,
  };
}

Deno.test('structured output uses provider-native strict JSON Schema', () => {
  const body = buildAIProviderRequestBody(
    {
      messages: [{ role: 'user', content: 'Extract this invoice.' }],
      output_schema: invoiceSchema,
    },
    'model-1',
    {
      response_format: { type: 'text' },
    },
  ) as Record<string, unknown>;

  assertEquals(body.response_format, {
    type: 'json_schema',
    json_schema: {
      name: 'invoice',
      schema: invoiceSchema.schema,
      strict: true,
    },
  });
});

Deno.test('structured output parses and verifies nested JSON values', () => {
  assertEquals(
    parseStructuredOutput(
      JSON.stringify({
        invoice_id: 'INV-1',
        total: 42.5,
        lines: [{ description: 'Service', quantity: 1 }],
      }),
      invoiceSchema,
    ),
    {
      invoice_id: 'INV-1',
      total: 42.5,
      lines: [{ description: 'Service', quantity: 1 }],
    },
  );
});

Deno.test('structured output returns typed JSON and schema errors', async () => {
  const usage = { input_tokens: 1, output_tokens: 1, cost_light: 0 };
  assertEquals(
    applyStructuredOutput({
      content: 'not-json',
      model: 'model-1',
      usage,
    }, invoiceSchema),
    {
      content: 'not-json',
      model: 'model-1',
      usage,
      output: undefined,
      error: 'Provider returned invalid JSON for structured output',
      error_code: 'structured_output_invalid_json',
    },
  );

  await assertRejects(
    async () =>
      parseStructuredOutput(
        JSON.stringify({
          invoice_id: 'INV-1',
          total: -1,
          lines: [],
        }),
        invoiceSchema,
      ),
    StructuredOutputError,
    'minimum',
  );
});

Deno.test('runtime AI returns response.output after native schema enforcement', async () => {
  const previousFetch = globalThis.fetch;
  let providerBody: Record<string, unknown> = {};
  try {
    globalThis.fetch = (async (_input, init) => {
      providerBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          model: 'deepseek-v4-pro',
          choices: [{
            message: {
              content: JSON.stringify({
                invoice_id: 'INV-1',
                total: 10,
                lines: [],
              }),
            },
          }],
          usage: { prompt_tokens: 5, completion_tokens: 8 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const response = await createRoutedRuntimeAIService(route(), 'user-1').call(
      {
        messages: [{ role: 'user', content: 'Extract.' }],
        output_schema: invoiceSchema,
      },
    );

    assertEquals(
      (providerBody.response_format as Record<string, unknown>)?.type,
      'json_schema',
    );
    assertEquals(response.output, {
      invoice_id: 'INV-1',
      total: 10,
      lines: [],
    });
    assertEquals(response.error, undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

Deno.test('runtime AI exposes typed unsupported errors without prompt fallback', async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: { message: 'response_format is unsupported' },
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        },
      )) as typeof fetch;

    const response = await createRoutedRuntimeAIService(route(), 'user-1').call(
      {
        messages: [{ role: 'user', content: 'Extract.' }],
        output_schema: invoiceSchema,
      },
    );

    assertEquals(response.error_code, 'structured_output_unsupported');
    assertEquals(response.output, undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

Deno.test('structured output rejects unsupported keywords and invalid keyword values', () => {
  for (const keyword of ['pattern', 'contains', 'dependentRequired']) {
    assertThrows(
      () =>
        normalizeOutputSchema({
          name: 'unsupported',
          schema: { type: 'string', [keyword]: 'value' },
        }),
      StructuredOutputError,
      `Unsupported JSON Schema keyword "${keyword}"`,
    );
  }

  assertThrows(
    () =>
      normalizeOutputSchema({
        name: 'bad_required',
        schema: { type: 'object', required: ['value', 'value'] },
      }),
    StructuredOutputError,
    'required must be an array of unique strings',
  );
  assertThrows(
    () =>
      normalizeOutputSchema({
        name: 'bad_number',
        schema: { type: 'number', multipleOf: 0 },
      }),
    StructuredOutputError,
    'multipleOf must be greater than zero',
  );
  assertThrows(
    () =>
      normalizeOutputSchema({
        name: 'not_strict',
        schema: true,
        strict: false,
      } as unknown as AIOutputSchema),
    StructuredOutputError,
    'always strict',
  );
});

Deno.test('structured output uses own properties for required and properties', () => {
  const prototypeNames = {
    name: 'prototype_names',
    schema: {
      type: 'object',
      properties: {
        toString: { type: 'string' },
        constructor: { type: 'integer' },
      },
      required: ['toString', 'constructor'],
      additionalProperties: false,
    },
  };

  assertEquals(
    parseStructuredOutput(
      '{"toString":"safe","constructor":1}',
      prototypeNames,
    ),
    { toString: 'safe', constructor: 1 },
  );
  assertThrows(
    () => parseStructuredOutput('{}', prototypeNames),
    StructuredOutputError,
    'Missing required property "toString"',
  );
});

Deno.test('structured output supports local refs and enforces ref siblings', () => {
  const schema = {
    name: 'local_ref',
    schema: {
      type: 'object',
      $defs: {
        identifier: { type: 'string' },
      },
      properties: {
        id: {
          $ref: '#/$defs/identifier',
          minLength: 3,
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  };

  assertEquals(parseStructuredOutput('{"id":"abc"}', schema), { id: 'abc' });
  assertThrows(
    () => parseStructuredOutput('{"id":"ab"}', schema),
    StructuredOutputError,
    'shorter than 3',
  );
  assertThrows(
    () =>
      normalizeOutputSchema({
        name: 'missing_ref',
        schema: { $ref: '#/$defs/missing', $defs: {} },
      }),
    StructuredOutputError,
    'Unresolvable JSON Schema reference',
  );
  assertThrows(
    () =>
      normalizeOutputSchema({
        name: 'cyclic_ref',
        schema: {
          $ref: '#/$defs/loop',
          $defs: { loop: { $ref: '#/$defs/loop' } },
        },
      }),
    StructuredOutputError,
    'Cyclic JSON Schema references',
  );
});

Deno.test('structured output bounds schema and output depth, size, and validation work', () => {
  let deepSchema: Record<string, unknown> = { type: 'string' };
  for (let index = 0; index < 40; index++) {
    deepSchema = { type: 'array', items: deepSchema };
  }
  assertThrows(
    () => normalizeOutputSchema({ name: 'deep_schema', schema: deepSchema }),
    StructuredOutputError,
    'maximum depth of 32',
  );

  let deepOutput: unknown = 'value';
  for (let index = 0; index < 65; index++) deepOutput = [deepOutput];
  assertThrows(
    () =>
      parseStructuredOutput(
        JSON.stringify(deepOutput),
        { name: 'deep_output', schema: true },
      ),
    StructuredOutputError,
    'maximum depth of 64',
  );

  assertThrows(
    () =>
      parseStructuredOutput(
        JSON.stringify('x'.repeat(2 * 1024 * 1024)),
        { name: 'large_output', schema: true },
      ),
    StructuredOutputError,
    'exceeds 2097152 bytes',
  );

  assertThrows(
    () =>
      parseStructuredOutput(
        JSON.stringify(Array(50_000).fill(0)),
        {
          name: 'too_many_steps',
          schema: { type: 'array', items: true },
        },
      ),
    StructuredOutputError,
    'exceeds 50000 steps',
  );
});

Deno.test('structured output caches a large value across composition branches', () => {
  const value = 'x'.repeat(256 * 1024);
  const candidates: Array<Record<string, unknown>> = Array.from(
    { length: 512 },
    (_, index) => ({ const: index }),
  );
  candidates.push({ type: 'string' });

  assertEquals(
    parseStructuredOutput(JSON.stringify(value), {
      name: 'branch_cache',
      schema: { anyOf: candidates },
    }),
    value,
  );
});

Deno.test('structured output bounds cumulative canonical equality work', () => {
  let output: unknown = 'x'.repeat(1024 * 1024);
  let schema: Record<string, unknown> = { type: 'string' };
  for (let depth = 0; depth < 20; depth += 1) {
    output = [output];
    schema = {
      type: 'array',
      uniqueItems: true,
      items: schema,
    };
  }

  assertThrows(
    () =>
      parseStructuredOutput(
        JSON.stringify(output),
        { name: 'canonical_budget', schema },
      ),
    StructuredOutputError,
    'canonical bytes',
  );
});

Deno.test('structured output rejects cyclic provider-parsed values', () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  const error = assertThrows(
    () =>
      parseStructuredOutput('', {
        name: 'cyclic_output',
        schema: true,
      }, cyclic),
    StructuredOutputError,
    'cyclic object reference',
  );
  assertEquals(error.code, 'structured_output_invalid_json');
});

Deno.test('raw provider calls defer structured validation for runtime settlement', async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      Response.json({
        model: 'deepseek-v4-pro',
        choices: [{ message: { content: '{"total":-1}' } }],
        usage: { prompt_tokens: 7, completion_tokens: 5 },
      })) as typeof fetch;

    const service = createAIService(
      'deepseek',
      'key',
      'deepseek-v4-pro',
    );
    const request = {
      messages: [{ role: 'user' as const, content: 'extract' }],
      output_schema: {
        name: 'invoice',
        schema: {
          type: 'object',
          properties: { total: { type: 'number', minimum: 0 } },
          required: ['total'],
          additionalProperties: false,
        },
      },
    };

    const raw = await service.callRaw(request);
    assertEquals(raw.error, undefined);
    assertEquals(raw.usage.input_tokens, 7);
    assertEquals(raw.usage.output_tokens, 5);

    const validated = await service.call(request);
    assertEquals(
      validated.error_code,
      'structured_output_schema_mismatch',
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

Deno.test('provider parsed values are exposed only when a schema validates them', () => {
  const response = {
    content: '',
    model: 'model-1',
    usage: { input_tokens: 2, output_tokens: 3, cost_light: 0 },
    output: { id: 'provider-parsed' },
  };
  assertEquals(applyStructuredOutput(response), {
    content: '',
    model: 'model-1',
    usage: { input_tokens: 2, output_tokens: 3, cost_light: 0 },
  });
  assertEquals(
    applyStructuredOutput(response, {
      name: 'parsed',
      schema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
    }).output,
    { id: 'provider-parsed' },
  );
});

Deno.test('unsupported-provider classification is narrow and status-aware', () => {
  assertEquals(
    isStructuredOutputUnsupportedProviderError(
      new AIProviderError(400, 'response_format json_schema is unsupported'),
    ),
    true,
  );
  assertEquals(
    isStructuredOutputUnsupportedProviderError(
      new AIProviderError(404, 'model was not found'),
    ),
    false,
  );
  assertEquals(
    isStructuredOutputUnsupportedProviderError(
      new AIProviderError(500, 'response_format is unsupported'),
    ),
    false,
  );
});

Deno.test('runtime rejects invalid schemas before making a provider request', async () => {
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    const response = await createRoutedRuntimeAIService(route(), 'user-1').call(
      {
        messages: [{ role: 'user', content: 'Extract.' }],
        output_schema: {
          name: 'invalid_before_fetch',
          schema: { type: 'string', pattern: '^x' },
        },
      },
    );

    assertEquals(response.error_code, 'invalid_output_schema');
    assertEquals(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

Deno.test('runtime does not misclassify unrelated provider errors', async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: { message: 'model was not found' } }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        },
      )) as typeof fetch;

    await assertRejects(
      () =>
        createRoutedRuntimeAIService(route(), 'user-1').call({
          messages: [{ role: 'user', content: 'Extract.' }],
          output_schema: invoiceSchema,
        }),
      AIProviderError,
      'model was not found',
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});
