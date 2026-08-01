import { type ReactElement, useRef, useState } from "react";

import type {
  LaunchAgentHomeRequirement,
  LaunchFleetSetupAgent,
  LaunchFleetSetupResponse,
} from "../../../../shared/contracts/launch.ts";
import {
  agentStudioSetupCapabilityId,
  clearStudioActionKey,
  getOrCreateStudioActionKey,
  remediateAgentStudioSetupGrant,
  retainIdempotencyKeyAfterFailure,
} from "../lib/agent-studio-state";
import { launchApi } from "../lib/api";
import type { LaunchNavigate } from "../lib/navigation";
import { ByokCredentialForm } from "./byok-credential-form";
import "./fleet-setup-panel.css";

function message(reason: unknown): string {
  return reason instanceof Error
    ? reason.message
    : "Setup could not be updated.";
}

function requirementHelp(requirement: LaunchAgentHomeRequirement): string {
  if (requirement.description) return requirement.description;
  if (requirement.kind === "setting") {
    return "This value is required by the exact deployed release.";
  }
  if (requirement.kind === "grant") {
    return "Allow this Agent to call the named private Agent function.";
  }
  if (requirement.kind === "capability") {
    return "Review and approve this required capability.";
  }
  return "Review this setup requirement.";
}

function SetupRequirementControl({
  agent,
  onChanged,
  requirement,
}: {
  agent: LaunchFleetSetupAgent;
  onChanged: () => void;
  requirement: LaunchAgentHomeRequirement;
}): ReactElement {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
      onChanged();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  if (
    requirement.kind === "setting" && requirement.settingKey &&
    agent.homeRevision
  ) {
    return (
      <div className="fleet-setup-control">
        <input
          autoComplete="off"
          onChange={(event) => setValue(event.currentTarget.value)}
          placeholder={requirement.placeholder ?? requirement.label}
          type={requirement.secret ? "password" : "text"}
          value={value}
        />
        <button
          disabled={busy || !value.trim()}
          onClick={() =>
            void run(() =>
              launchApi.updateAgentHomeSettings(agent.agent.slug, {
                expectedRevision: agent.homeRevision!,
                values: { [requirement.settingKey!]: value },
              })
            )}
          type="button"
        >
          {busy ? "Saving…" : requirement.configured ? "Replace" : "Save"}
        </button>
        {requirement.secret ? <small>Encrypted and write-only.</small> : null}
        {error
          ? <small className="fleet-setup-error" role="alert">{error}</small>
          : null}
      </div>
    );
  }

  if (
    requirement.kind === "capability" &&
    requirement.actions.includes("approve") && agent.homeRevision
  ) {
    return (
      <div className="fleet-setup-control">
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const home = await launchApi.agentHome(agent.agent.slug);
              const capabilityId = agentStudioSetupCapabilityId(
                home,
                requirement.id,
              );
              if (!capabilityId) {
                throw new Error(
                  "This approval changed. Refresh setup and review it again.",
                );
              }
              return await launchApi.actOnAgentHome(agent.agent.slug, {
                action: "approve_capabilities",
                capabilityIds: [capabilityId],
                expectedRevision: home.revision,
                idempotencyKey: crypto.randomUUID(),
              });
            })}
          type="button"
        >
          {busy ? "Approving…" : "Review and approve"}
        </button>
        {error
          ? <small className="fleet-setup-error" role="alert">{error}</small>
          : null}
      </div>
    );
  }

  if (requirement.kind === "grant") {
    return (
      <div className="fleet-setup-control">
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const home = await launchApi.agentHome(agent.agent.slug);
              return await remediateAgentStudioSetupGrant(
                launchApi,
                home,
                requirement.id,
              );
            })}
          type="button"
        >
          {busy ? "Connecting…" : "Review and connect"}
        </button>
        {error
          ? <small className="fleet-setup-error" role="alert">{error}</small>
          : null}
      </div>
    );
  }

  return (
    <>{error ? <small className="fleet-setup-error">{error}</small> : null}</>
  );
}

function AgentSetupCard({
  agent,
  navigate,
  onChanged,
}: {
  agent: LaunchFleetSetupAgent;
  navigate: LaunchNavigate;
  onChanged: () => void;
}): ReactElement {
  const [activating, setActivating] = useState(false);
  const [activationError, setActivationError] = useState("");
  const actionKeys = useRef(new Map<string, string>());
  const requirements = agent.requirements.filter((requirement) =>
    requirement.id !== "inference:byok" && requirement.required
  );
  const remaining = requirements.filter((requirement) => requirement.blocking);

  const activate = async () => {
    if (!agent.homeRevision || activating || !agent.canActivate) return;
    const signature = `${agent.agent.id}:fleet:activate:${agent.homeRevision}`;
    const idempotencyKey = getOrCreateStudioActionKey(
      signature,
      actionKeys.current,
    );
    setActivating(true);
    setActivationError("");
    try {
      await launchApi.actOnAgentHome(agent.agent.slug, {
        action: "activate",
        expectedRevision: agent.homeRevision,
        idempotencyKey,
      });
      clearStudioActionKey(signature, actionKeys.current);
      onChanged();
    } catch (reason) {
      if (!retainIdempotencyKeyAfterFailure(reason)) {
        clearStudioActionKey(signature, actionKeys.current);
      }
      setActivationError(message(reason));
    } finally {
      setActivating(false);
    }
  };

  return (
    <article className="fleet-setup-agent">
      <header>
        <div>
          <span className="fleet-setup-kicker">Agent setup</span>
          <h3>{agent.agent.name}</h3>
        </div>
        <span className={agent.canActivate ? "ready" : "waiting"}>
          {agent.syncing
            ? "Syncing"
            : agent.canActivate
            ? "Ready to activate"
            : remaining.length === 0
            ? "Review required"
            : `${remaining.length} left`}
        </span>
      </header>
      {agent.syncing ? <p>{agent.unavailableReason}</p> : null}
      {!agent.syncing && requirements.length === 0
        ? (
          <p>
            The release needs no additional Agent-specific credentials or
            approvals.
          </p>
        )
        : null}
      {!agent.syncing && remaining.length === 0 && !agent.canActivate
        ? (
          <p>
            Review any remaining release or routine details in Agent Studio
            before activation.
          </p>
        )
        : null}
      <div className="fleet-setup-requirements">
        {requirements.map((requirement) => (
          <div
            className={`fleet-setup-requirement${
              requirement.configured ? " complete" : ""
            }`}
            key={requirement.id}
          >
            <span className="fleet-setup-check" aria-hidden="true">
              {requirement.configured ? "✓" : "·"}
            </span>
            <div>
              <strong>{requirement.label}</strong>
              <p>{requirementHelp(requirement)}</p>
              {!requirement.configured
                ? (
                  <SetupRequirementControl
                    agent={agent}
                    onChanged={onChanged}
                    requirement={requirement}
                  />
                )
                : null}
            </div>
          </div>
        ))}
      </div>
      <footer>
        <button
          className="fleet-setup-studio-link"
          onClick={() =>
            navigate(
              `/agents/${encodeURIComponent(agent.agent.slug)}?pane=overview`,
            )}
          type="button"
        >
          Open Agent Studio
        </button>
        <button
          className="fleet-setup-activate"
          disabled={!agent.canActivate || activating}
          onClick={() => void activate()}
          type="button"
        >
          {activating ? "Activating…" : "Review and activate"}
        </button>
      </footer>
      {activationError
        ? <p className="fleet-setup-error" role="alert">{activationError}</p>
        : null}
    </article>
  );
}

export function FleetSetupPanel({
  error,
  navigate,
  onChanged,
  setup,
}: {
  error?: string;
  navigate: LaunchNavigate;
  onChanged: () => void;
  setup?: LaunchFleetSetupResponse;
}): ReactElement | null {
  if (!setup?.pendingAgentCount && !error) return null;
  return (
    <section className="fleet-setup-panel" aria-label="Finish Agent setup">
      <div className="fleet-setup-heading">
        <div>
          <span className="fleet-setup-kicker">Membership active</span>
          <h2>
            Finish setting up {setup?.pendingAgentCount ?? "your"}{" "}
            {setup?.pendingAgentCount === 1 ? "Agent" : "Agents"}
          </h2>
          <p>
            Your Agents are private and paused until you review their setup and
            activate them.
          </p>
        </div>
        {setup ? <span>{setup.readyToActivateCount} ready</span> : null}
      </div>
      {error ? <p className="fleet-setup-error" role="alert">{error}</p> : null}
      {setup?.inference && setup.inference.readiness !== "ready"
        ? (
          <div className="fleet-setup-shared-step">
            <div className="fleet-setup-step-number">1</div>
            <div>
              <h3>Connect your model provider</h3>
              <p>
                {setup.inference.functions.length}{" "}
                function{setup.inference.functions.length === 1 ? "" : "s"}{" "}
                across your deployed Agents use inference. Test and save one
                compatible key for all of them.
              </p>
              <ByokCredentialForm
                initialProviderId={setup.inference.configuredProviderId}
                onSaved={onChanged}
                requiredOperations={setup.inference.operations}
                saveLabel="Save and continue"
              />
            </div>
          </div>
        )
        : setup?.inference
        ? (
          <div className="fleet-setup-shared-complete">
            ✓ Model provider tested and connected
          </div>
        )
        : null}
      <div className="fleet-setup-agent-grid">
        {setup?.agents.map((agent) => (
          <AgentSetupCard
            agent={agent}
            key={agent.agent.id}
            navigate={navigate}
            onChanged={onChanged}
          />
        ))}
      </div>
    </section>
  );
}
