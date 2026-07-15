// Deterministic host responses for gx.test. These values are returned only by
// parent-worker RPC bindings selected through RuntimeConfig.testMode; tenant
// source cannot enable them or obtain provider/inbox credentials.

export const UL_TEST_AI_CONTENT = JSON.stringify({
  assessment: "gx.test deterministic AI response",
  actions: [],
});

export function createUlTestAiResponse() {
  return {
    content: UL_TEST_AI_CONTENT,
    model: "gx-test-stub",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cost_light: 0,
    },
  };
}

export function createUlTestEmbedResponse() {
  return {
    embedding: [0, 0, 0, 0],
    model: "gx-test-embedding-stub",
    dimensions: 4,
    usage: {
      input_tokens: 0,
      total_tokens: 0,
      cost_light: 0,
    },
  };
}

export function createUlTestNotifyResponse() {
  return {
    created: false,
    reason: "test_mode",
  };
}

export function createUlTestMemoryAdapter() {
  const values = new Map<string, unknown>();
  return {
    async remember(key: string, value: unknown): Promise<void> {
      values.set(key, value);
    },
    async recall(key: string): Promise<unknown> {
      return values.has(key) ? values.get(key) : null;
    },
  };
}
