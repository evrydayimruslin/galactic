import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInferenceOptionsResponse } from '../../../shared/contracts/ai.ts';

const storageMock = vi.hoisted(() => ({
  token: 'desktop-test-token' as string | null,
  fetchFromApi: vi.fn(),
}));

vi.mock('./storage', () => ({
  DEFAULT_CHAT_MODEL: 'deepseek/deepseek-v4-flash',
  DEFAULT_INTERPRETER_MODEL: 'deepseek/deepseek-v4-flash',
  DEFAULT_HEAVY_MODEL: 'deepseek/deepseek-v4-pro',
  getApiBase: () => 'https://ultralight-api.rgn4jz429m.workers.dev',
  getToken: () => storageMock.token,
  fetchFromApi: storageMock.fetchFromApi,
}));

const inferencePayload: ChatInferenceOptionsResponse = {
  defaultBillingMode: 'byok',
  selected: {
    billingMode: 'byok',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    webSearchEnabled: false,
  },
  light: {
    provider: 'openrouter',
    defaultModel: 'deepseek/deepseek-v4-flash',
    models: [
      { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1_048_576 },
    ],
    balanceLight: 12,
    minimumBalanceLight: 50,
    usable: false,
    markup: 1,
    unavailableReason: 'Light balance below 50',
  },
  providers: [
    {
      id: 'openrouter',
      name: 'OpenRouter',
      description: 'Platform model gateway',
      protocol: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'deepseek/deepseek-v4-flash',
      models: [
        { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1_048_576 },
      ],
      capabilities: { chat: true, streaming: true, tools: true, jsonMode: true, multimodal: true, realtime: false, webSearch: true },
      docsUrl: 'https://openrouter.ai/docs',
      apiKeyUrl: 'https://openrouter.ai/settings/keys',
      configured: false,
      primary: false,
      configuredModel: null,
      addedAt: null,
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      description: 'DeepSeek native API',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      defaultModel: 'deepseek-v4-flash',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1_048_576 },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1_048_576 },
      ],
      capabilities: { chat: true, streaming: true, tools: true, jsonMode: true, multimodal: false, realtime: false, webSearch: false },
      docsUrl: 'https://api-docs.deepseek.com',
      apiKeyUrl: 'https://platform.deepseek.com/api_keys',
      configured: true,
      primary: true,
      configuredModel: 'deepseek-v4-pro',
      addedAt: '2026-04-27T00:00:00.000Z',
    },
    {
      id: 'openai',
      name: 'OpenAI',
      description: 'OpenAI API',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o-mini',
      models: [
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128_000 },
      ],
      capabilities: { chat: true, streaming: true, tools: true, jsonMode: true, multimodal: true, realtime: true, webSearch: true },
      docsUrl: 'https://platform.openai.com/docs',
      apiKeyUrl: 'https://platform.openai.com/api-keys',
      configured: false,
      primary: false,
      configuredModel: null,
      addedAt: null,
    },
  ],
  configuredProviderIds: ['deepseek'],
};

function sseResponse(lines: string[] = ['data: [DONE]\n\n']): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const line of lines) {
          controller.enqueue(encoder.encode(line));
        }
        controller.close();
      },
    }),
    { status: 200 },
  );
}

describe('inference API helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    storageMock.token = 'desktop-test-token';
    storageMock.fetchFromApi.mockReset();
  });

  it('fetches provider-aware inference settings with auth headers', async () => {
    storageMock.fetchFromApi.mockResolvedValueOnce(
      new Response(JSON.stringify(inferencePayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { fetchInferenceSettings } = await import('./api');
    const settings = await fetchInferenceSettings();

    expect(storageMock.fetchFromApi).toHaveBeenCalledWith('/chat/inference-options', {
      headers: {
        Authorization: 'Bearer desktop-test-token',
        'Content-Type': 'application/json',
      },
    });
    expect(settings.selected).toEqual(inferencePayload.selected);
  });

  it('falls back to the static first-tier registry without auth', async () => {
    storageMock.token = null;

    const { fetchInferenceSettings } = await import('./api');
    const settings = await fetchInferenceSettings();

    expect(storageMock.fetchFromApi).not.toHaveBeenCalled();
    expect(settings.defaultBillingMode).toBe('light');
    expect(settings.selected).toEqual({
      billingMode: 'light',
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash',
      webSearchEnabled: false,
    });
    expect(settings.providers.map((provider) => provider.id)).toEqual([
      'openrouter',
      'openai',
      'deepseek',
      'nvidia',
      'google',
      'xai',
    ]);
  });

  it('derives provider choices, model options, and setup state', async () => {
    const {
      getEffectiveInferencePreference,
      buildInferenceSetupPrompt,
      describeInferenceModel,
      formatInferenceModelContext,
      formatInferenceModelPrice,
      getInferenceModelOptions,
      getInferenceProviderChoices,
      getInferenceSetupState,
      getUsableInferenceProviderChoices,
    } = await import('./api');

    expect(getEffectiveInferencePreference(inferencePayload)).toEqual({
      billingMode: 'byok',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      webSearchEnabled: false,
    });
    expect(
      getInferenceProviderChoices(inferencePayload).map((choice) => ({
        key: choice.key,
        usable: choice.usable,
        configured: choice.configured,
      })),
    ).toEqual([
      { key: 'light:openrouter', usable: false, configured: true },
      { key: 'byok:openrouter', usable: false, configured: false },
      { key: 'byok:deepseek', usable: true, configured: true },
      { key: 'byok:openai', usable: false, configured: false },
    ]);
    expect(getUsableInferenceProviderChoices(inferencePayload).map((choice) => choice.key)).toEqual(
      [
        'byok:deepseek',
      ],
    );
    expect(
      getInferenceModelOptions(inferencePayload).map((model) => ({
        id: model.id,
        billingMode: model.billingMode,
        providerName: model.providerName,
      })),
    ).toEqual([
      { id: 'deepseek-v4-flash', billingMode: 'byok', providerName: 'DeepSeek' },
      { id: 'deepseek-v4-pro', billingMode: 'byok', providerName: 'DeepSeek' },
    ]);
    expect(getInferenceSetupState(inferencePayload)).toBe('ready');
    expect(getInferenceSetupState(inferencePayload, { billingMode: 'light' })).toBe(
      'needs_light_balance',
    );
    expect(getInferenceSetupState(inferencePayload, { billingMode: 'byok', provider: 'openai' }))
      .toBe('needs_byok_key');
    expect(buildInferenceSetupPrompt(inferencePayload)).toBeNull();
    expect(buildInferenceSetupPrompt(inferencePayload, { billingMode: 'light' })).toMatchObject({
      state: 'needs_light_balance',
      primaryAction: { action: 'open_wallet' },
    });
    expect(buildInferenceSetupPrompt(inferencePayload, { billingMode: 'byok', provider: 'openai' }))
      .toMatchObject({
        state: 'needs_byok_key',
        primaryAction: { action: 'open_settings' },
      });

    const lightUsablePayload = {
      ...inferencePayload,
      light: { ...inferencePayload.light, usable: true, balanceLight: 500 },
    };
    expect(
      buildInferenceSetupPrompt(lightUsablePayload, { billingMode: 'byok', provider: 'openai' }),
    ).toMatchObject({
      state: 'needs_byok_key',
      secondaryAction: { action: 'use_light' },
    });

    expect(formatInferenceModelContext(1_048_576)).toBe('1M ctx');
    expect(formatInferenceModelContext(128_000)).toBe('128K ctx');
    expect(formatInferenceModelPrice(0.14, 0.28)).toBe('$0.14 in / $0.28 out per 1M');
    expect(describeInferenceModel({
      contextWindow: 1_048_576,
      inputPrice: 1.74,
      outputPrice: 3.48,
    })).toBe('1M ctx | $1.74 in / $3.48 out per 1M');
  });

  it('includes inference preferences in chat stream requests', async () => {
    storageMock.fetchFromApi.mockResolvedValueOnce(sseResponse());

    const { streamChat } = await import('./api');
    for await (
      const _event of streamChat({
        model: 'deepseek/deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hello' }],
        inference: { billingMode: 'byok', provider: 'deepseek', model: 'deepseek-v4-pro' },
      })
    ) {
      // drain stream
    }

    const init = storageMock.fetchFromApi.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'deepseek/deepseek-v4-flash',
      inference: {
        billingMode: 'byok',
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
      },
    });
  });

  it('includes inference preferences in orchestrate requests', async () => {
    storageMock.fetchFromApi.mockResolvedValueOnce(sseResponse());

    const { streamOrchestrate } = await import('./api');
    for await (
      const _event of streamOrchestrate({
        message: 'build a thing',
        inference: { billingMode: 'light', model: 'deepseek/deepseek-v4-flash' },
      })
    ) {
      // drain stream
    }

    const init = storageMock.fetchFromApi.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toMatchObject({
      message: 'build a thing',
      inference: {
        billingMode: 'light',
        model: 'deepseek/deepseek-v4-flash',
      },
    });
  });

  it('formats structured orchestrate setup errors', async () => {
    storageMock.fetchFromApi.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'Insufficient balance',
          balance_light: 12,
          minimum_light: 50,
          topup_url: '/wallet',
        }),
        {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const { streamOrchestrate } = await import('./api');
    const events = [];
    for await (
      const event of streamOrchestrate({
        message: 'hello',
        inference: { billingMode: 'light' },
      })
    ) {
      events.push(event);
    }

    expect(events).toEqual([expect.objectContaining({
      type: 'error',
      status: 402,
      message: 'Insufficient balance (✦12 remaining). Add Light from Wallet.',
      balance_light: 12,
      minimum_light: 50,
      topup_url: '/wallet',
    })]);
  });
});
