import { type ReactElement, type ReactNode } from "react";

interface FleetRosterProps {
  behindWorkspace: boolean;
  children: ReactNode;
  error?: string;
  loading: boolean;
}

export function FleetLoadingBar({
  label = "Loading agents",
}: {
  label?: string;
}): ReactElement {
  return (
    <div
      className="neb-fleet-loading"
      role="status"
      aria-label={label}
    >
      <span />
    </div>
  );
}

export function FleetRoster({
  behindWorkspace,
  children,
  error,
  loading,
}: FleetRosterProps): ReactElement {
  return (
    <section
      className={behindWorkspace ? "neb-fleet-behind-open" : undefined}
      aria-label="Your Agent fleet"
    >
      {error ? <p className="neb-error-note">{error}</p> : null}
      <div className="neb-roster">
        {loading
          ? <FleetLoadingBar />
          : children}
      </div>
    </section>
  );
}
