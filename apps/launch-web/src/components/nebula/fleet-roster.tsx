import { type ReactElement, type ReactNode } from "react";

interface FleetRosterProps {
  behindWorkspace: boolean;
  children: ReactNode;
  error?: string;
  loading: boolean;
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
          ? (
            <div
              className="neb-fleet-loading"
              role="status"
              aria-label="Loading agents"
            >
              <span />
            </div>
          )
          : children}
      </div>
    </section>
  );
}
