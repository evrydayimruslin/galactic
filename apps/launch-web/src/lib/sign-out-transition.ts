import { signOutLaunch } from "./auth";
import type { LaunchNavigate } from "./navigation";

export function signOutToConnect(
  navigate: LaunchNavigate,
  signOut: () => Promise<void> = signOutLaunch,
): Promise<void> {
  // Move the focused Settings page first so the synchronous auth-change event
  // can only render the signed-out Connect workspace, never the legacy
  // compatibility surface for /account.
  navigate("/connect", { replace: true, scroll: "preserve" });
  return signOut();
}
