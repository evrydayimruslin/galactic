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
  tokenAppIds: string[] | null;
  tokenFunctionNames: string[] | null;
  scopes?: string[];
  routineActor?: AuthenticatedRequestUser['routineActor'];
  // Verified cross-Agent caller identity (from a valid X-Ultralight-Caller
  // header). Present only when this request is one Agent calling another on
  // behalf of the user; drives the cross-Agent grant check.
  callerApp?: {
    appId: string;
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
    tokenAppIds: null,
    tokenFunctionNames: null,
    scopes: undefined,
    routineActor: undefined,
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
      tokenAppIds: authUser.tokenAppIds || null,
      tokenFunctionNames: authUser.tokenFunctionNames || null,
      scopes: authUser.scopes,
      routineActor: authUser.routineActor,
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
