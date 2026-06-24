// AI Fan-out — reference Agent for best-of-N / "fusion" on Ultralight.
//
// There is no special fan-out primitive: ultralight.ai() is a plain async call,
// so you fan out with Promise.all and synthesize with one more call. That's it.
//
// Mind the ceilings (see docs/IN-APP-SDK-DESIGN.md → "Fan-out / best-of-N"):
//   - each ai() call is one subrequest (budget: apps 512 / codemode 128)
//   - the whole execution must finish in 30s (default) / 120s (max)
//   - every branch is billed; the balance gate is pre-call + fail-open and
//     there is no mid-flight abort, so keep N modest.

const ultralight = globalThis.ultralight;

// Swap these for any model ids your account can route. Keep N small: every
// branch costs Light and counts against the per-execution subrequest budget.
const DEFAULT_MODELS = [
  'openai/gpt-4o-mini',
  'anthropic/claude-3.5-haiku',
  'deepseek/deepseek-chat',
];
const MAX_MODELS = 6;

interface AiResponse {
  content: string;
  model: string;
  usage?: { cost_light?: number };
}

export async function best_of_n(args: {
  question?: string;
  models?: string[];
}): Promise<{
  answer: string;
  drafts: Array<{ model: string; content: string }>;
  total_cost_light: number;
}> {
  const question = (args?.question || '').toString().trim();
  if (!question) throw new Error('question is required');

  const models =
    (Array.isArray(args?.models) && args.models.length > 0 ? args.models : DEFAULT_MODELS).slice(
      0,
      MAX_MODELS,
    );

  const prompt = [{ role: 'user', content: question }];

  // ── Fan out: one parallel ai() call per model. Promise.all is the trick. ──
  const drafts = await Promise.all(
    models.map(async (model) => {
      try {
        const r = (await ultralight.ai({ model, messages: prompt })) as AiResponse;
        return { model, content: r.content || '', cost: r.usage?.cost_light || 0 };
      } catch (err) {
        // A single failed branch must not sink the whole fan-out.
        const reason = err instanceof Error ? err.message : String(err);
        return { model, content: `(model ${model} failed: ${reason})`, cost: 0 };
      }
    }),
  );

  const usable = drafts.filter((d) => d.content && !d.content.startsWith('(model '));
  if (usable.length === 0) throw new Error('all model branches failed');

  // ── Synthesize: one more call fuses the drafts into a single best answer. ──
  const fused = (await ultralight.ai({
    messages: [{
      role: 'user',
      content: `Question:\n${question}\n\n` +
        `Candidate answers from different models:\n` +
        usable.map((d, i) => `[${i + 1}] (${d.model})\n${d.content}`).join('\n\n') +
        `\n\nWrite a single best answer combining the strongest, most accurate ` +
        `points across the candidates. Resolve disagreements; do not mention the ` +
        `candidates or that you merged them.`,
    }],
  })) as AiResponse;

  const totalCost = drafts.reduce((sum, d) => sum + d.cost, 0) +
    (fused.usage?.cost_light || 0);

  return {
    answer: fused.content,
    drafts: drafts.map((d) => ({ model: d.model, content: d.content })),
    total_cost_light: totalCost,
  };
}
