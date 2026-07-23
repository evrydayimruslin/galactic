export interface LaunchNavigateOptions {
  replace?: boolean;
  scroll?: "preserve" | "top";
}

export type LaunchNavigate = (
  to: string,
  options?: LaunchNavigateOptions,
) => void;

/**
 * Dismiss a top-level focused workspace without adding another browser-history
 * entry. The workspace itself was opened with a push, so replacing its entry
 * prevents Back from immediately reopening the page the operator just closed.
 */
export function dismissLaunchWorkspace(
  navigate: LaunchNavigate,
  returnToAlerts = false,
): void {
  navigate(returnToAlerts ? "/?panel=alerts" : "/", { replace: true });
}

/**
 * Resolve in-app destinations against the current document, not the site
 * origin. This keeps query-only Agent object links on `/agents/:slug` while
 * still producing an absolute URL for the external-navigation guard.
 */
export function resolveLaunchNavigationTarget(
  to: string,
  currentHref: string,
): URL {
  return new URL(to, currentHref);
}
