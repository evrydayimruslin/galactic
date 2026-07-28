import { assert } from 'https://deno.land/std@0.210.0/assert/assert.ts';

const source = await Deno.readTextFile(
  new URL('./ai-binding.ts', import.meta.url),
);

Deno.test('dynamic AI binding admits structured schemas before billing work', () => {
  const callStart = source.indexOf('async call(request: AIRequest');
  const schemaAdmission = source.indexOf(
    'responseFormat = structuredOutputResponseFormat(request.output_schema)',
    callStart,
  );
  const balanceGate = source.indexOf('if (metered)', callStart);
  const budgetAdmission = source.indexOf('if (routineContext)', callStart);
  const providerAttempt = source.indexOf(
    'let result = await attempt(model)',
    callStart,
  );

  assert(callStart >= 0, 'AIBinding.call must exist');
  assert(schemaAdmission > callStart, 'structured schema admission must exist');
  assert(
    schemaAdmission < balanceGate,
    'structured schema admission must precede the wallet balance RPC',
  );
  assert(
    schemaAdmission < budgetAdmission,
    'structured schema admission must precede routine budget admission',
  );
  assert(
    schemaAdmission < providerAttempt,
    'structured schema admission must precede provider inference',
  );
});
