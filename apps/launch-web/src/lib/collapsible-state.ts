function normalizedTarget(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

/**
 * A route target reopens its section whenever browser history reintroduces it.
 * Merely rerendering an unchanged target does not override a user's manual
 * close, while leaving and returning to that target does.
 */
export function reconcileCollapsibleRouteTarget(
  open: boolean,
  previousTarget: string | null | undefined,
  nextTarget: string | null | undefined,
): boolean {
  const previous = normalizedTarget(previousTarget);
  const next = normalizedTarget(nextTarget);
  return next !== null && next !== previous ? true : open;
}
