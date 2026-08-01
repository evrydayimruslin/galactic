import {
  type ReactElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  LaunchByokProviderOption,
  LaunchInferenceOperation,
} from "../../../../shared/contracts/launch.ts";
import { launchApi, LaunchApiRequestError } from "../lib/api";
import "./byok-credential-form.css";

const DEFAULT_OPERATIONS: LaunchInferenceOperation[] = ["generate"];

function providerSupports(
  provider: LaunchByokProviderOption,
  operations: readonly LaunchInferenceOperation[],
): boolean {
  return operations.every((operation) =>
    operation === "generate"
      ? provider.capabilities.chat
      : provider.capabilities.embeddings
  );
}

function validationMessage(reason: unknown): string {
  if (!(reason instanceof LaunchApiRequestError)) {
    return reason instanceof Error
      ? reason.message
      : "The key could not be tested.";
  }
  switch (reason.code) {
    case "invalid_key":
      return "That key was rejected. Check that it is active and copied in full.";
    case "rate_limited":
      return "The provider rate-limited the test. Wait a moment, then try again.";
    case "model_unavailable":
      return "That model is not available to this key. Choose another model and retest.";
    case "unsupported_operation":
      return "This provider cannot perform every operation these Agents need.";
    case "validation_timeout":
      return "The provider did not respond in time. Your key was not saved; try again.";
    case "expired_receipt":
    case "invalid_receipt":
      return "The tested values changed or expired. Test the key again before saving.";
    default:
      return reason.message || "The key could not be tested.";
  }
}

export interface ByokCredentialFormProps {
  initialProviderId?: string | null;
  onCancel?: () => void;
  onSaved?: () => Promise<void> | void;
  providerOptions?: LaunchByokProviderOption[];
  requiredOperations?: LaunchInferenceOperation[];
  saveLabel?: string;
}

export function ByokCredentialForm({
  initialProviderId,
  onCancel,
  onSaved,
  providerOptions,
  requiredOperations = DEFAULT_OPERATIONS,
  saveLabel = "Save key",
}: ByokCredentialFormProps): ReactElement {
  const operationsKey = [...new Set(requiredOperations)].sort().join(",");
  const operations = useMemo(
    () =>
      operationsKey.split(",").filter(Boolean) as LaunchInferenceOperation[],
    [operationsKey],
  );
  const [providers, setProviders] = useState(providerOptions ?? []);
  const [providerId, setProviderId] = useState(initialProviderId ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [receipt, setReceipt] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [phase, setPhase] = useState<
    "idle" | "loading" | "testing" | "tested" | "saving" | "saved"
  >(
    providerOptions ? "idle" : "loading",
  );
  const [error, setError] = useState("");
  const previousOperationsKey = useRef(operationsKey);
  const modelListId = useId();

  useEffect(() => {
    if (previousOperationsKey.current === operationsKey) return;
    previousOperationsKey.current = operationsKey;
    setReceipt("");
    setExpiresAt("");
    setError("");
    setPhase((current) => current === "loading" ? current : "idle");
  }, [operationsKey]);

  useEffect(() => {
    if (providerOptions) {
      setProviders(providerOptions);
      setPhase("idle");
      return;
    }
    let active = true;
    void launchApi.byok().then((response) => {
      if (!active) return;
      setProviders(response.providers);
      setPhase("idle");
    }).catch((reason) => {
      if (!active) return;
      setError(
        reason instanceof Error
          ? reason.message
          : "Providers could not be loaded.",
      );
      setPhase("idle");
    });
    return () => {
      active = false;
    };
  }, [providerOptions]);

  const compatibleProviders = useMemo(
    () =>
      providers.filter((provider) => providerSupports(provider, operations)),
    [providers, operationsKey],
  );

  useEffect(() => {
    const preferred = compatibleProviders.find((provider) =>
      provider.id === providerId
    ) ??
      compatibleProviders.find((provider) =>
        provider.id === initialProviderId
      ) ??
      compatibleProviders.find((provider) => provider.primary) ??
      compatibleProviders[0];
    if (!preferred) return;
    if (preferred.id !== providerId) setProviderId(preferred.id);
    if (!model) setModel(preferred.model ?? preferred.defaultModel ?? "");
  }, [compatibleProviders, initialProviderId, model, providerId]);

  const selected =
    compatibleProviders.find((provider) => provider.id === providerId) ?? null;
  const invalidateTest = () => {
    setReceipt("");
    setExpiresAt("");
    setError("");
    if (phase === "tested") setPhase("idle");
  };

  const test = async () => {
    if (
      !selected || !apiKey.trim() || phase === "testing" || phase === "saving"
    ) return;
    setPhase("testing");
    setError("");
    setReceipt("");
    try {
      const response = await launchApi.validateByok({
        provider: selected.id,
        apiKey: apiKey.trim(),
        model: model.trim() || undefined,
        operations,
      });
      setReceipt(response.validationReceipt);
      setExpiresAt(response.expiresAt);
      setModel(response.model ?? model);
      setPhase("tested");
    } catch (reason) {
      setError(validationMessage(reason));
      setPhase("idle");
    }
  };

  const save = async () => {
    if (!selected || !receipt || phase === "saving") return;
    if (Date.parse(expiresAt) <= Date.now()) {
      setReceipt("");
      setPhase("idle");
      setError("The key test expired. Test it again before saving.");
      return;
    }
    setPhase("saving");
    setError("");
    try {
      await launchApi.upsertByokProvider(selected.id, {
        apiKey: apiKey.trim(),
        model: model.trim() || undefined,
        operations,
        validationReceipt: receipt,
        setPrimary: true,
      });
      setApiKey("");
      setReceipt("");
      setPhase("saved");
    } catch (reason) {
      setError(validationMessage(reason));
      setPhase(
        reason instanceof LaunchApiRequestError &&
          (reason.code === "expired_receipt" ||
            reason.code === "invalid_receipt")
          ? "idle"
          : "tested",
      );
      if (
        reason instanceof LaunchApiRequestError &&
        (reason.code === "expired_receipt" || reason.code === "invalid_receipt")
      ) {
        setReceipt("");
      }
      return;
    }
    try {
      await onSaved?.();
    } catch {
      setError(
        "Key saved, but setup could not refresh. Reload the page to continue.",
      );
    }
  };

  return (
    <div className="galactic-byok-form">
      {phase === "loading"
        ? <p className="galactic-byok-note">Loading providers…</p>
        : null}
      {compatibleProviders.length > 0
        ? (
          <div className="galactic-byok-fields">
            <label>
              <span>Provider</span>
              <select
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  const provider = compatibleProviders.find((option) =>
                    option.id === next
                  );
                  setProviderId(next);
                  setModel(provider?.model ?? provider?.defaultModel ?? "");
                  invalidateTest();
                }}
                value={providerId}
              >
                {compatibleProviders.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>API key</span>
              <input
                autoComplete="off"
                onChange={(event) => {
                  setApiKey(event.currentTarget.value);
                  invalidateTest();
                }}
                placeholder={selected?.configured
                  ? "Enter a replacement key"
                  : selected?.apiKeyPrefix ?? "sk-…"}
                type="password"
                value={apiKey}
              />
            </label>
            <label>
              <span>Default model</span>
              <input
                list={modelListId}
                onChange={(event) => {
                  setModel(event.currentTarget.value);
                  invalidateTest();
                }}
                value={model}
              />
              <datalist id={modelListId}>
                {(selected?.models ?? []).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </datalist>
            </label>
          </div>
        )
        : phase !== "loading"
        ? (
          <p className="galactic-byok-error">
            No provider supports every required inference operation.
          </p>
        )
        : null}
      <div className="galactic-byok-actions">
        <button
          className="galactic-byok-test"
          disabled={!selected || !apiKey.trim() || phase === "testing" ||
            phase === "saving"}
          onClick={() => void test()}
          type="button"
        >
          {phase === "testing"
            ? "Testing…"
            : phase === "tested"
            ? "Test again"
            : "Test key"}
        </button>
        <button
          className="galactic-byok-save"
          disabled={!receipt || phase === "saving"}
          onClick={() => void save()}
          type="button"
        >
          {phase === "saving" ? "Saving…" : saveLabel}
        </button>
        {onCancel
          ? <button onClick={onCancel} type="button">Cancel</button>
          : null}
      </div>
      {phase === "tested"
        ? (
          <p className="galactic-byok-success">
            Key tested successfully. Save it within five minutes.
          </p>
        )
        : null}
      {phase === "saved"
        ? <p className="galactic-byok-success">Key saved.</p>
        : null}
      {error
        ? <p className="galactic-byok-error" role="alert">{error}</p>
        : null}
      <p className="galactic-byok-note">
        Encrypted and write-only; Galactic never displays your key.
      </p>
      <p className="galactic-byok-note">
        Low-cost models often cost only a few dollars per month for light
        workloads; billed directly by your provider.
      </p>
    </div>
  );
}
