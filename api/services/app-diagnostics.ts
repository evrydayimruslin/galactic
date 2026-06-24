import type { App } from "../../shared/types/index.ts";

export type AppSecretDiagnosticsState =
  | "not_required"
  | "ready"
  | "action_required";

export interface AppSecretDiagnostics {
  type: "APP_SECRETS";
  state: AppSecretDiagnosticsState;
  app_id: string;
  declared_keys: string[];
  required_keys: string[];
  connected_keys: string[];
  missing_required: string[];
  message: string;
  remediation: string;
  connect_command: string | null;
}

export interface BuildAppSecretDiagnosticsInput {
  appId: string;
  declaredKeys: string[];
  requiredKeys: string[];
  connectedKeys: string[];
  missingRequired: string[];
}

export interface SharingPermissionDiagnosticRow {
  function_name: string;
  granted_to_user_id?: string | null;
}

export type AppSharingDiagnosticsState =
  | "owner_view"
  | "explicit_share"
  | "visibility_access";

export interface AppSharingDiagnostics {
  type: "APP_SHARING";
  state: AppSharingDiagnosticsState;
  visibility: App["visibility"];
  explicit_permission_count: number;
  granted_user_count: number;
  functions_with_explicit_permissions: string[];
  functions_without_explicit_permissions: string[];
  message: string;
  remediation: string;
}

export interface BuildAppSharingDiagnosticsInput {
  isOwner: boolean;
  visibility: App["visibility"];
  availableFunctions: string[];
  permissions?: SharingPermissionDiagnosticRow[] | null;
}

export interface AppAccessRequiredDiagnostics {
  type: "APP_ACCESS_REQUIRED";
  app_id: string;
  visibility: App["visibility"];
  message: string;
  remediation: string;
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names.filter((name) => !!name))];
}

function sortNamesByAvailability(
  names: string[],
  availableFunctions: string[],
): string[] {
  const availableIndex = new Map(
    availableFunctions.map((name, index) => [name, index]),
  );

  return [...names].sort((left, right) => {
    const leftIndex = availableIndex.get(left);
    const rightIndex = availableIndex.get(right);

    if (leftIndex !== undefined && rightIndex !== undefined) {
      return leftIndex - rightIndex;
    }
    if (leftIndex !== undefined) return -1;
    if (rightIndex !== undefined) return 1;
    return left.localeCompare(right);
  });
}

function buildConnectCommand(appId: string, keys: string[]): string | null {
  if (keys.length === 0) {
    return null;
  }

  const placeholderMap = Object.fromEntries(
    keys.map((key) => [key, `<${key}>`]),
  );
  return `gx.secrets({ app_id: "${appId}", secrets: ${
    JSON.stringify(placeholderMap)
  } })`;
}

export function buildAppSecretDiagnostics(
  input: BuildAppSecretDiagnosticsInput,
): AppSecretDiagnostics {
  const declaredKeys = uniqueNames(input.declaredKeys);
  const requiredKeys = uniqueNames(input.requiredKeys);
  const connectedKeys = uniqueNames(input.connectedKeys);
  const missingRequired = uniqueNames(input.missingRequired);

  if (declaredKeys.length === 0) {
    return {
      type: "APP_SECRETS",
      state: "not_required",
      app_id: input.appId,
      declared_keys: declaredKeys,
      required_keys: requiredKeys,
      connected_keys: connectedKeys,
      missing_required: missingRequired,
      message: "This app has no per-user settings.",
      remediation: "No user secrets are required.",
      connect_command: null,
    };
  }

  if (missingRequired.length > 0) {
    return {
      type: "APP_SECRETS",
      state: "action_required",
      app_id: input.appId,
      declared_keys: declaredKeys,
      required_keys: requiredKeys,
      connected_keys: connectedKeys,
      missing_required: missingRequired,
      message:
        `Per-user settings are incomplete. Missing required keys: ${
          missingRequired.join(", ")
        }.`,
      remediation:
        "Provide the missing secrets with gx.secrets before running the app.",
      connect_command: buildConnectCommand(input.appId, missingRequired),
    };
  }

  if (connectedKeys.length === 0 && requiredKeys.length === 0) {
    return {
      type: "APP_SECRETS",
      state: "ready",
      app_id: input.appId,
      declared_keys: declaredKeys,
      required_keys: requiredKeys,
      connected_keys: connectedKeys,
      missing_required: missingRequired,
      message:
        "This app declares optional per-user settings, but none are required right now.",
      remediation:
        "No action is required unless you want to configure the optional settings.",
      connect_command: null,
    };
  }

  return {
    type: "APP_SECRETS",
    state: "ready",
    app_id: input.appId,
    declared_keys: declaredKeys,
    required_keys: requiredKeys,
    connected_keys: connectedKeys,
    missing_required: missingRequired,
    message: "Per-user settings are ready.",
    remediation: "No action needed.",
    connect_command: null,
  };
}

export function buildAppSharingDiagnostics(
  input: BuildAppSharingDiagnosticsInput,
): AppSharingDiagnostics {
  const permissions = input.permissions || [];
  const availableFunctions = uniqueNames(input.availableFunctions);
  const functionsWithExplicitPermissions = sortNamesByAvailability(
    uniqueNames(permissions.map((row) => row.function_name)),
    availableFunctions,
  );
  const functionsWithoutExplicitPermissions = sortNamesByAvailability(
    availableFunctions.filter((name) =>
      !functionsWithExplicitPermissions.includes(name)
    ),
    availableFunctions,
  );
  const grantedUserCount = new Set(
    permissions
      .map((row) => row.granted_to_user_id || null)
      .filter((userId): userId is string => !!userId),
  ).size;

  if (input.isOwner) {
    const message = functionsWithExplicitPermissions.length === 0
      ? input.visibility === "private"
        ? "This private app has no explicit share rows yet."
        : "This app has no explicit share rows yet."
      : `Explicit share rows cover ${functionsWithExplicitPermissions.length} of ${availableFunctions.length || functionsWithExplicitPermissions.length} functions.`;

    const remediation = functionsWithoutExplicitPermissions.length > 0
      ? input.visibility === "private"
        ? "Grant explicit access for each function collaborators should call."
        : "Add explicit share rows when you want tighter per-function control."
      : "No action needed.";

    return {
      type: "APP_SHARING",
      state: "owner_view",
      visibility: input.visibility,
      explicit_permission_count: permissions.length,
      granted_user_count: grantedUserCount,
      functions_with_explicit_permissions: functionsWithExplicitPermissions,
      functions_without_explicit_permissions: functionsWithoutExplicitPermissions,
      message,
      remediation,
    };
  }

  if (functionsWithExplicitPermissions.length > 0) {
    return {
      type: "APP_SHARING",
      state: "explicit_share",
      visibility: input.visibility,
      explicit_permission_count: permissions.length,
      granted_user_count: grantedUserCount,
      functions_with_explicit_permissions: functionsWithExplicitPermissions,
      functions_without_explicit_permissions: functionsWithoutExplicitPermissions,
      message:
        `You have explicit share rows for ${functionsWithExplicitPermissions.length} function(s).`,
      remediation: "No action needed unless you expected additional functions.",
    };
  }

  return {
    type: "APP_SHARING",
    state: "visibility_access",
    visibility: input.visibility,
    explicit_permission_count: permissions.length,
    granted_user_count: grantedUserCount,
    functions_with_explicit_permissions: functionsWithExplicitPermissions,
    functions_without_explicit_permissions: functionsWithoutExplicitPermissions,
    message:
      `This app is visible because it is ${input.visibility}. No explicit share rows are attached to your account.`,
    remediation:
      "Ask the owner for an explicit share if you expected private, per-function access control.",
  };
}

export function buildAppAccessRequiredDiagnostics(
  appId: string,
  visibility: App["visibility"],
): AppAccessRequiredDiagnostics {
  const accessType = visibility === "private"
    ? "private"
    : `${visibility}-visibility`;

  return {
    type: "APP_ACCESS_REQUIRED",
    app_id: appId,
    visibility,
    message:
      `This ${accessType} app requires a valid share before you can inspect or connect it.`,
    remediation:
      `Ask the owner to grant access, then retry gx.discover({ scope: "inspect", app_id: "${appId}" }) or gx.secrets({ app_id: "${appId}", secrets: { ... } }).`,
  };
}
