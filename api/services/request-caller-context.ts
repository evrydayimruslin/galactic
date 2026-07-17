import type { UserContext } from '../runtime/sandbox.ts';
import { isApiToken } from './tokens.ts';
import {
  authenticateRequest,
  extractRequestAccessToken,
  hasScope,
  type AuthenticatedRequestUser,
  type RequestAuthSource,
  type RequestTokenSourcePolicy,
} from './request-auth.ts';
import { createUserService, type UserProfile } from './user.ts';
import { FREE_MODE_BALANCE_LIGHT } from '../../shared/contracts/ai.ts';

export const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

export interface RequestCallerContext {
  authState: 'authenticated' | 'anonymous';
  authSource?: RequestAuthSource;
  authUser: AuthenticatedRequestUser | null;
  authToken?: string;
  authError?: Error;
  userId: string;
  user: UserContext | null;
  userProfile: UserProfile | null;
  userApiKey: string | null;
  // Caller economic state (Free Mode signals — see docs/FREE_MODE_DESIGN.md).
  // Computed once here so discovery + execution read a consistent view.
  /** Spendable balance in Light, or null when unknown (load failed / anonymous). */
  balanceLight: number | null;
  /** balanceLight is known AND below the free-mode threshold. Fails OPEN: an
   *  unknown balance is NOT free mode, so a paying user is never wrongly gated. */
  freeMode: boolean;
  /** Caller has a usable BYOK key — BYOK inference draws no platform credits. */
  byokPresent: boolean;
  tokenAppIds: string[] | null;
  tokenFunctionNames: string[] | null;
  scopes?: string[];
  routineContext?: AuthenticatedRequestUser['routineContext'];
  routineCapabilityCeiling?: AuthenticatedRequestUser['routineCapabilityCeiling'];
  routineActor?: AuthenticatedRequestUser['routineActor'];
  sandboxActor?: AuthenticatedRequestUser['sandboxActor'];
  // Verified cross-Agent caller identity (from a valid X-Galactic-Caller
  // header). Present only when this request is one Agent calling another on
  // behalf of the user; drives the cross-Agent grant check.
  callerApp?: {
    appId: string;
    capacityAgentId?: string;
    callerFunction: string | null;
    hop: number;
  };
}

interface ResolveRequestCallerContextOptions {
  authSourcePolicy?: RequestTokenSourcePolicy;
  allowAnonymous?: boolean;
  invalidAuthPolicy?: 'ignore' | 'throw';
  loadUserProfile?: boolean;
  loadUserApiKey?: boolean;
}

interface RequestCallerContextDeps {
  authenticateRequestFn?: typeof authenticateRequest;
  extractRequestAccessTokenFn?: typeof extractRequestAccessToken;
  createUserServiceFn?: typeof createUserService;
}

function buildAnonymousContext(
  authToken?: string,
  authError?: Error,
): RequestCallerContext {
  return {
    authState: 'anonymous',
    authSource: undefined,
    authUser: null,
    authToken,
    authError,
    userId: ANONYMOUS_USER_ID,
    user: null,
    userProfile: null,
    userApiKey: null,
    balanceLight: null,
    freeMode: false,
    byokPresent: false,
    tokenAppIds: null,
    tokenFunctionNames: null,
    scopes: undefined,
    routineContext: undefined,
    routineCapabilityCeiling: undefined,
    routineActor: undefined,
    sandboxActor: undefined,
  };
}

/**
 * Derive Free Mode signals from a loaded user profile. Fails open: a null
 * profile (load failed / anonymous) yields freeMode=false so a paying user is
 * never wrongly gated. See docs/FREE_MODE_DESIGN.md.
 */
export function deriveCallerEconomicState(
  profile:
    | Pick<UserProfile, 'balance_light' | 'byok_enabled' | 'byok_provider'>
    | null,
): { balanceLight: number | null; freeMode: boolean; byokPresent: boolean } {
  const balanceLight = typeof profile?.balance_light === 'number'
    ? profile.balance_light
    : null;
  return {
    balanceLight,
    freeMode: balanceLight !== null && balanceLight < FREE_MODE_BALANCE_LIGHT,
    byokPresent: Boolean(profile?.byok_enabled && profile.byok_provider),
  };
}

export async function resolveRequestCallerContext(
  request: Request,
  options?: ResolveRequestCallerContextOptions,
  deps?: RequestCallerContextDeps,
): Promise<RequestCallerContext> {
  const authSourcePolicy = options?.authSourcePolicy ?? 'bearer_or_cookie';
  const allowAnonymous = options?.allowAnonymous ?? false;
  const invalidAuthPolicy = options?.invalidAuthPolicy ?? 'throw';
  const loadUserProfile = options?.loadUserProfile ?? true;
  const loadUserApiKey = options?.loadUserApiKey ?? true;

  const authenticateRequestFn = deps?.authenticateRequestFn ?? authenticateRequest;
  const extractRequestAccessTokenFn = deps?.extractRequestAccessTokenFn ?? extractRequestAccessToken;
  const createUserServiceFn = deps?.createUserServiceFn ?? createUserService;

  const authToken = extractRequestAccessTokenFn(request, authSourcePolicy) || undefined;
  if (!authToken) {
    if (allowAnonymous) {
      return buildAnonymousContext();
    }
    throw new Error('Missing or invalid authorization header');
  }

  try {
    const authUser = await authenticateRequestFn(request, authSourcePolicy);
    const userService = createUserServiceFn();
    const userProfile = loadUserProfile ? await userService.getUser(authUser.id).catch(() => null) : null;
    let userApiKey: string | null = null;
    if (loadUserApiKey && userProfile?.byok_enabled && userProfile.byok_provider) {
      try {
        userApiKey = await userService.getDecryptedApiKey(authUser.id, userProfile.byok_provider);
      } catch (err) {
        console.error('[AUTH] Failed to load caller API key:', err);
      }
    }

    const displayName = userProfile?.display_name
      || authUser.user_metadata?.full_name
      || authUser.user_metadata?.name
      || authUser.email.split('@')[0]
      || null;
    const avatarUrl = userProfile?.avatar_url
      || authUser.user_metadata?.avatar_url
      || null;

    const { balanceLight, freeMode, byokPresent } = deriveCallerEconomicState(userProfile);

    return {
      authState: 'authenticated',
      authSource: authUser.authSource,
      authUser,
      authToken,
      userId: authUser.id,
      user: {
        id: authUser.id,
        email: authUser.email,
        displayName,
        avatarUrl,
        tier: authUser.tier,
        provisional: authUser.provisional || false,
      },
      userProfile,
      userApiKey,
      balanceLight,
      freeMode,
      byokPresent,
      tokenAppIds: authUser.tokenAppIds || null,
      tokenFunctionNames: authUser.tokenFunctionNames || null,
      scopes: authUser.scopes,
      routineContext: authUser.routineContext,
      routineCapabilityCeiling: authUser.routineCapabilityCeiling,
      routineActor: authUser.routineActor,
      sandboxActor: authUser.sandboxActor,
    };
  } catch (err) {
    if (allowAnonymous && invalidAuthPolicy === 'ignore') {
      return buildAnonymousContext(undefined, err instanceof Error ? err : new Error(String(err)));
    }
    throw err;
  }
}

export function callerHasAppAccess(
  caller: Pick<RequestCallerContext, 'tokenAppIds'>,
  appIdentifiers: Array<string | null | undefined>,
): boolean {
  if (!caller.tokenAppIds || caller.tokenAppIds.length === 0 || caller.tokenAppIds.includes('*')) {
    return true;
  }

  const allowedIdentifiers = new Set(appIdentifiers.filter((value): value is string => !!value));
  return caller.tokenAppIds.some(identifier => allowedIdentifiers.has(identifier));
}

export function callerHasFunctionAccess(
  caller: Pick<RequestCallerContext, 'tokenFunctionNames'>,
  functionIdentifiers: Array<string | null | undefined>,
): boolean {
  if (!caller.tokenFunctionNames || caller.tokenFunctionNames.length === 0 || caller.tokenFunctionNames.includes('*')) {
    return true;
  }

  const allowedIdentifiers = new Set(functionIdentifiers.filter((value): value is string => !!value));
  return caller.tokenFunctionNames.some(identifier => allowedIdentifiers.has(identifier));
}

/**
 * Enforce a routine's exact approved `(target Agent, function)` authority.
 * Flattened app/function token scopes are intentionally insufficient because
 * they permit the cross-product A.g/B.f when only A.f and B.g were approved.
 */
export function callerWithinRoutineCapabilityCeiling(
  caller: Pick<
    RequestCallerContext,
    | 'routineContext'
    | 'routineCapabilityCeiling'
    | 'routineActor'
    | 'sandboxActor'
  >,
  targetAppIdentifiers: Array<string | null | undefined>,
  functionIdentifiers: Array<string | null | undefined>,
): boolean {
  if (!caller.routineContext) return true;

  const targets = new Set(
    targetAppIdentifiers.filter((value): value is string => !!value),
  );
  const functions = new Set(
    functionIdentifiers.filter((value): value is string => !!value),
  );

  // The root routine actor may invoke only its signed composer handler.
  const composerMatches = [
    caller.routineActor?.composerAppId,
    caller.routineActor?.composerAppSlug,
  ].some((identifier) => !!identifier && targets.has(identifier));
  if (
    composerMatches && caller.routineActor?.handlerFunction &&
    functions.has(caller.routineActor.handlerFunction)
  ) return true;

  // Once inside a sandbox, calls back into that same executing Agent do not
  // expand authority. Use the signed bearer app_id, never a caller-supplied
  // header, to establish this self-call exception.
  if (
    caller.sandboxActor?.appId && targets.has(caller.sandboxActor.appId)
  ) return true;

  return (caller.routineCapabilityCeiling ?? []).some((capability) => {
    const targetMatches = [capability.app_id, capability.app_ref]
      .some((identifier) => !!identifier && targets.has(identifier));
    return targetMatches && functions.has(capability.function_name);
  });
}

export function callerHasRequiredScope(
  caller: Pick<RequestCallerContext, 'scopes'>,
  requiredScope: string,
): boolean {
  return hasScope(caller.scopes, requiredScope);
}

export function callerUsesApiToken(
  caller: Pick<RequestCallerContext, 'authToken' | 'authState'>,
): boolean {
  return caller.authState === 'authenticated' && !!caller.authToken && isApiToken(caller.authToken);
}

export function callerUsesRoutineActorToken(
  caller: Pick<RequestCallerContext, 'authSource' | 'authState'>,
): boolean {
  return caller.authState === 'authenticated' && caller.authSource === 'routine_actor';
}

export function callerUsesSandboxActorToken(
  caller: Pick<RequestCallerContext, 'authSource' | 'authState'>,
): boolean {
  return caller.authState === 'authenticated' && caller.authSource === 'sandbox_actor';
}

/**
 * Synthetic MCP SDK tools are a legacy host-control surface, not tenant
 * exports. A signed routine/sandbox actor must use the in-sandbox bindings,
 * where manifest permissions and routine attribution are enforced. Otherwise
 * a routine could call self `ultralight.ai`/storage/memory over MCP even when
 * those capabilities were never bound into its sandbox.
 */
export function callerCanInvokeMcpTool(
  caller: Pick<RequestCallerContext, 'authSource' | 'authState'>,
  toolName: string,
): boolean {
  const syntheticSdkTool = toolName.startsWith('ultralight.') ||
    toolName.startsWith('ul.');
  if (!syntheticSdkTool) return true;
  return !callerUsesRoutineActorToken(caller) &&
    !callerUsesSandboxActorToken(caller);
}

/**
 * Legacy /run and /http execution do not propagate the signed routine
 * capability ceiling or immutable actor attribution into nested sandbox work.
 * Keep actor execution on MCP until those routes carry the complete context.
 */
export function callerCanUseLegacyExecutionRoute(
  caller: Pick<RequestCallerContext, 'authSource' | 'authState'>,
): boolean {
  return caller.authSource !== 'routine_actor' &&
    caller.authSource !== 'sandbox_actor';
}
