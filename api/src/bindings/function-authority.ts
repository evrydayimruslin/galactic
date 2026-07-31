/**
 * Parent-isolate authority gate for multiplexed RPC bindings.
 *
 * `undefined` preserves bindings constructed before function authority existed.
 * New runtime construction always sends an explicit boolean, so `false` is a
 * hard fail before any credential, network, or storage operation can begin.
 */
export function assertBindingEffectAuthority(
  allowed: boolean | undefined,
  effect: string,
): void {
  if (allowed === false) {
    throw new Error(`${effect} authority not granted for this function.`);
  }
}
