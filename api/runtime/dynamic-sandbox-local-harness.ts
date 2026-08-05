/**
 * Worker Loader evaluates generated modules as ESM. The in-memory gx.test
 * harness uses `Function` instead, so its trusted setup module needs the ESM
 * export modifiers removed before compilation. Strip every line-leading
 * export rather than maintaining a fragile allowlist of helper names.
 */
export function dynamicSandboxSetupForFunctionHarness(
  setupModule: string,
): string {
  return setupModule.replace(/^export\s+/gmu, "");
}
