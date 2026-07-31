/**
 * Locale-independent string ordering for any sequence that contributes to a
 * digest. JavaScript's relational comparison is defined over UTF-16 code units,
 * which matches RFC 8785 object-key ordering and is reproducible without
 * consulting the host locale.
 */
export function compareCanonicalStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
