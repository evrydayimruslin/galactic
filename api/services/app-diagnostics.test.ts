import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  buildAppAccessRequiredDiagnostics,
  buildAppSecretDiagnostics,
  buildAppSharingDiagnostics,
} from "./app-diagnostics.ts";

Deno.test("app diagnostics: secret diagnostics point users to ul.secrets when required keys are missing", () => {
  const diagnostics = buildAppSecretDiagnostics({
    appId: "app-123",
    declaredKeys: ["USER_TOKEN", "OPTIONAL_BASE_URL"],
    requiredKeys: ["USER_TOKEN"],
    connectedKeys: ["OPTIONAL_BASE_URL"],
    missingRequired: ["USER_TOKEN"],
  });

  assertEquals(diagnostics, {
    type: "APP_SECRETS",
    state: "action_required",
    app_id: "app-123",
    declared_keys: ["USER_TOKEN", "OPTIONAL_BASE_URL"],
    required_keys: ["USER_TOKEN"],
    connected_keys: ["OPTIONAL_BASE_URL"],
    missing_required: ["USER_TOKEN"],
    message:
      "Per-user settings are incomplete. Missing required keys: USER_TOKEN.",
    remediation:
      "Provide the missing secrets with ul.secrets before running the app.",
    connect_command:
      'ul.secrets({ app_id: "app-123", secrets: {"USER_TOKEN":"<USER_TOKEN>"} })',
  });
});

Deno.test("app diagnostics: secret diagnostics explain when no per-user settings exist", () => {
  const diagnostics = buildAppSecretDiagnostics({
    appId: "app-123",
    declaredKeys: [],
    requiredKeys: [],
    connectedKeys: [],
    missingRequired: [],
  });

  assertEquals(diagnostics.state, "not_required");
  assertEquals(diagnostics.message, "This app has no per-user settings.");
  assertEquals(diagnostics.connect_command, null);
});

Deno.test("app diagnostics: owner sharing diagnostics call out unshared private functions", () => {
  const diagnostics = buildAppSharingDiagnostics({
    isOwner: true,
    visibility: "private",
    availableFunctions: ["search", "save"],
    permissions: [{ function_name: "search", granted_to_user_id: "user-2" }],
  });

  assertEquals(diagnostics, {
    type: "APP_SHARING",
    state: "owner_view",
    visibility: "private",
    explicit_permission_count: 1,
    granted_user_count: 1,
    functions_with_explicit_permissions: ["search"],
    functions_without_explicit_permissions: ["save"],
    message: "Explicit share rows cover 1 of 2 functions.",
    remediation:
      "Grant explicit access for each function collaborators should call.",
  });
});

Deno.test("app diagnostics: viewer sharing diagnostics summarize explicit access", () => {
  const diagnostics = buildAppSharingDiagnostics({
    isOwner: false,
    visibility: "private",
    availableFunctions: ["search", "save"],
    permissions: [{ function_name: "search" }],
  });

  assertEquals(diagnostics.state, "explicit_share");
  assertEquals(
    diagnostics.message,
    "You have explicit share rows for 1 function(s).",
  );
  assertEquals(diagnostics.functions_without_explicit_permissions, ["save"]);
});

Deno.test("app diagnostics: access required diagnostics explain how to retry", () => {
  const diagnostics = buildAppAccessRequiredDiagnostics("app-123", "private");

  assertEquals(diagnostics, {
    type: "APP_ACCESS_REQUIRED",
    app_id: "app-123",
    visibility: "private",
    message:
      "This private app requires a valid share before you can inspect or connect it.",
    remediation:
      'Ask the owner to grant access, then retry ul.discover({ scope: "inspect", app_id: "app-123" }) or ul.secrets({ app_id: "app-123", secrets: { ... } }).',
  });
});
