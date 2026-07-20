import type {
  ComputeRequest,
  ComputeResult,
  ComputeRun,
} from '../../../shared/contracts/compute.ts';

/**
 * Identity for an in-Agent compute call. Every field is derived in the parent
 * Worker; none is accepted from tenant code or copied from the request body.
 */
export interface ComputeControlPlaneActor {
  userId: string;
  agentId: string;
  callerFunction: string;
  executionId: string;
}

export interface ComputeAdmissionInput extends ComputeControlPlaneActor {
  /** Stable UUID derived from parent execution + SDK call index. */
  idempotencyKey: string;
  /** Absolute parent-isolate deadline, resolved host-side from the opaque handle. */
  executionDeadlineAtMs: number;
  /** Trusted billing route inherited from the enclosing Agent execution. */
  billingMode: 'wallet' | 'subscription_capacity';
  /** Root Agent whose account/Agent capacity pool owns the Compute lease. */
  capacityAgentId: string;
  request: ComputeRequest;
}

export interface ComputeRunLookupInput extends ComputeControlPlaneActor {
  runId: string;
}

/**
 * Narrow seam between the Dynamic Worker RPC binding and the control-plane
 * compute services. The service implementation owns authoritative request
 * validation, permission/policy checks, budget reservation, admission, and
 * run ownership checks.
 */
export interface ComputeControlPlaneAdapter {
  admitComputeRun(input: ComputeAdmissionInput): Promise<ComputeResult>;
  getComputeRunForAgent(input: ComputeRunLookupInput): Promise<ComputeRun>;
  cancelComputeRunForAgent(input: ComputeRunLookupInput): Promise<ComputeRun>;
}

/**
 * Expected denials may cross the binding with this explicitly public error.
 * All other errors are replaced with a generic message before entering the
 * body, so a database/provider exception cannot leak a token or credential.
 */
export class PublicComputeControlPlaneError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PublicComputeControlPlaneError';
    this.code = code;
  }
}

let installedAdapter: ComputeControlPlaneAdapter | null = null;

/**
 * Install the API control-plane implementation during Worker bootstrap.
 * Reinstalling a different implementation in one isolate is refused so one
 * request cannot swap the authority boundary for another.
 */
export function installComputeControlPlaneAdapter(
  adapter: ComputeControlPlaneAdapter,
): void {
  if (installedAdapter && installedAdapter !== adapter) {
    throw new Error(
      'Galactic Compute control-plane adapter is already installed',
    );
  }
  installedAdapter = adapter;
}

export function requireComputeControlPlaneAdapter(): ComputeControlPlaneAdapter {
  if (!installedAdapter) {
    throw new Error('Galactic Compute control-plane adapter is not installed');
  }
  return installedAdapter;
}
