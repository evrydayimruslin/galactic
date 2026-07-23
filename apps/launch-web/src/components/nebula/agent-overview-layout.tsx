import { Fragment, type ReactElement, type ReactNode } from "react";

export interface AgentOverviewLayoutProps {
  afterIdentity: readonly AgentOverviewSection[];
  beforeIdentity: readonly AgentOverviewSection[];
  connection: ReactNode;
  error?: string;
  identity: ReactNode;
  overlay?: ReactNode;
}

export interface AgentOverviewSection {
  content: ReactNode;
  key: string;
}

export function AgentOverviewLayout({
  afterIdentity,
  beforeIdentity,
  connection,
  error,
  identity,
  overlay,
}: AgentOverviewLayoutProps): ReactElement {
  return (
    <section className="neb-modal-pane active neb-agent-overview">
      {error ? <p className="neb-error-note" role="alert">{error}</p> : null}
      {beforeIdentity.map((section) => (
        <Fragment key={section.key}>{section.content}</Fragment>
      ))}
      {identity}
      {connection}
      {afterIdentity.map((section) => (
        <Fragment key={section.key}>{section.content}</Fragment>
      ))}
      {overlay}
    </section>
  );
}
