import { assert } from 'https://deno.land/std@0.210.0/assert/assert.ts';
import { assertEquals } from 'https://deno.land/std@0.210.0/assert/assert_equals.ts';
import {
  ACTIVE_BYOK_PROVIDER_IDS,
  BYOK_PROVIDERS,
  isActiveBYOKProvider,
  isLegacyBYOKProvider,
} from '../../shared/types/index.ts';

Deno.test('BYOK provider registry exposes first-tier OpenAI-compatible providers', () => {
  assertEquals(Object.keys(BYOK_PROVIDERS), [...ACTIVE_BYOK_PROVIDER_IDS]);

  for (const provider of Object.values(BYOK_PROVIDERS)) {
    assertEquals(provider.protocol, 'openai-compatible');
    assert(provider.baseUrl.startsWith('https://'));
    assert(provider.defaultModel.length > 0);
    assert(provider.models.length > 0);
    assert(provider.capabilities.chat);
    assert(provider.capabilities.streaming);
    assertEquals(typeof provider.capabilities.realtime, 'boolean');
  }
});

Deno.test('BYOK provider registry marks only OpenAI as realtime-capable', () => {
  assertEquals(BYOK_PROVIDERS.openai.capabilities.realtime, true);
  for (const provider of Object.values(BYOK_PROVIDERS)) {
    if (provider.id !== 'openai') {
      assertEquals(provider.capabilities.realtime, false);
    }
  }
});

Deno.test('BYOK provider registry excludes legacy direct providers', () => {
  assert(!('anthropic' in BYOK_PROVIDERS));
  assert(!('moonshot' in BYOK_PROVIDERS));
  assert(isLegacyBYOKProvider('anthropic'));
  assert(isLegacyBYOKProvider('moonshot'));
});

Deno.test('BYOK active provider guard accepts only current first-tier providers', () => {
  for (const provider of ACTIVE_BYOK_PROVIDER_IDS) {
    assert(isActiveBYOKProvider(provider));
  }

  assert(!isActiveBYOKProvider('anthropic'));
  assert(!isActiveBYOKProvider('moonshot'));
  assert(!isActiveBYOKProvider('_platform_openrouter'));
});
