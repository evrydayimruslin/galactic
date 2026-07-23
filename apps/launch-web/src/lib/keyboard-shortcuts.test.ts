import { describe, expect, it } from "vitest";

import {
  createLaunchShortcutConfiguration,
  DEFAULT_LAUNCH_SHORTCUT_CONFIGURATION,
  isLaunchShortcutProtectedTarget,
  LAUNCH_SHORTCUT_ACTIONS,
  launchAgentShortcutAction,
  launchAgentShortcutPosition,
  LaunchShortcutConfigurationError,
  launchShortcutAriaKeyShortcuts,
  launchShortcutDisplayLabel,
  resolveLaunchShortcut,
  validateLaunchShortcutPreferences,
  type LaunchShortcutEventLike,
} from "./keyboard-shortcuts";

interface FakeElementOptions {
  attributes?: Record<string, string>;
  contentEditable?: boolean;
  parent?: unknown;
}

function element(
  tagName: string,
  options: FakeElementOptions = {},
): {
  getAttribute(name: string): string | null;
  isContentEditable: boolean;
  parentElement: unknown;
  tagName: string;
} {
  return {
    tagName,
    isContentEditable: options.contentEditable ?? false,
    parentElement: options.parent ?? null,
    getAttribute(name: string) {
      return options.attributes?.[name] ?? null;
    },
  };
}

function keyEvent(
  key: string,
  overrides: Partial<LaunchShortcutEventLike> = {},
): LaunchShortcutEventLike {
  return { key, ...overrides };
}

describe("default launch keyboard shortcuts", () => {
  it("maps K/A/S, fleet positions, help, and dismiss without a C action", () => {
    expect(DEFAULT_LAUNCH_SHORTCUT_CONFIGURATION.bindings).toEqual({
      search: "k",
      alerts: "a",
      settings: "s",
      "agent-1": "1",
      "agent-2": "2",
      "agent-3": "3",
      "agent-4": "4",
      "agent-5": "5",
      "agent-6": "6",
      "agent-7": "7",
      "agent-8": "8",
      "agent-9": "9",
      "agent-10": "0",
      help: "?",
      dismiss: "Escape",
    });
    expect(LAUNCH_SHORTCUT_ACTIONS).not.toContain("connect");
    expect(Object.values(DEFAULT_LAUNCH_SHORTCUT_CONFIGURATION.bindings))
      .not.toContain("c");
    expect(Object.isFrozen(DEFAULT_LAUNCH_SHORTCUT_CONFIGURATION)).toBe(true);
    expect(Object.isFrozen(DEFAULT_LAUNCH_SHORTCUT_CONFIGURATION.bindings))
      .toBe(true);
  });

  it.each([
    ["k", "search"],
    ["K", "search"],
    ["a", "alerts"],
    ["s", "settings"],
    ["1", "agent-1"],
    ["2", "agent-2"],
    ["3", "agent-3"],
    ["4", "agent-4"],
    ["5", "agent-5"],
    ["6", "agent-6"],
    ["7", "agent-7"],
    ["8", "agent-8"],
    ["9", "agent-9"],
    ["0", "agent-10"],
    ["?", "help"],
    ["Escape", "dismiss"],
    ["Esc", "dismiss"],
  ] as const)("resolves %s to %s", (key, action) => {
    expect(resolveLaunchShortcut(keyEvent(key))).toBe(action);
  });

  it("allows Shift only when it produces the bound printable symbol", () => {
    expect(resolveLaunchShortcut(keyEvent("?", { shiftKey: true })))
      .toBe("help");
    expect(resolveLaunchShortcut(keyEvent("K", { shiftKey: true })))
      .toBeNull();
    expect(resolveLaunchShortcut(keyEvent("Escape", { shiftKey: true })))
      .toBeNull();
  });
});

describe("shortcut focus and event policy", () => {
  it.each(["INPUT", "TEXTAREA", "SELECT", "IFRAME"])(
    "protects %s targets",
    (tagName) => {
      expect(isLaunchShortcutProtectedTarget(element(tagName))).toBe(true);
      expect(resolveLaunchShortcut(keyEvent("k", {
        target: element(tagName),
      }))).toBeNull();
    },
  );

  it("protects contenteditable regions and editable ARIA controls", () => {
    const editor = element("DIV", {
      attributes: { contenteditable: "true" },
    });
    const editorChild = element("SPAN", { parent: editor });
    const plaintextEditor = element("DIV", {
      attributes: { contenteditable: "plaintext-only" },
    });
    const textbox = element("DIV", {
      attributes: { role: "textbox" },
    });

    expect(isLaunchShortcutProtectedTarget(editor)).toBe(true);
    expect(isLaunchShortcutProtectedTarget(editorChild)).toBe(true);
    expect(isLaunchShortcutProtectedTarget(plaintextEditor)).toBe(true);
    expect(isLaunchShortcutProtectedTarget(textbox)).toBe(true);
  });

  it("respects a contenteditable=false island and ordinary focused buttons", () => {
    const editor = element("DIV", {
      attributes: { contenteditable: "true" },
    });
    const nonEditableIsland = element("DIV", {
      attributes: { contenteditable: "false" },
      parent: editor,
    });
    const child = element("SPAN", { parent: nonEditableIsland });

    expect(isLaunchShortcutProtectedTarget(child)).toBe(false);
    expect(resolveLaunchShortcut(keyEvent("a", { target: child })))
      .toBe("alerts");
    expect(resolveLaunchShortcut(keyEvent("s", {
      target: element("BUTTON"),
    }))).toBe("settings");
  });

  it("uses activeElement to suppress shortcuts while an iframe owns focus", () => {
    expect(resolveLaunchShortcut(keyEvent("k"), {
      activeElement: element("IFRAME"),
    })).toBeNull();
  });

  it("defers entirely to an active dialog", () => {
    expect(resolveLaunchShortcut(keyEvent("Escape"), {
      dialogActive: true,
    })).toBeNull();
    expect(resolveLaunchShortcut(keyEvent("k"), {
      dialogActive: true,
    })).toBeNull();
  });

  it.each([
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { repeat: true },
    { isComposing: true },
    { keyCode: 229 },
    { defaultPrevented: true },
  ])("ignores blocked event state $", (blockedState) => {
    expect(resolveLaunchShortcut(keyEvent("k", blockedState))).toBeNull();
  });

  it("applies the complete focus and event policy to workspace dismissal", () => {
    const blocked: Array<{
      context?: Parameters<typeof resolveLaunchShortcut>[1];
      event: LaunchShortcutEventLike;
    }> = [
      { event: keyEvent("Escape", { target: element("INPUT") }) },
      {
        event: keyEvent("Escape"),
        context: { activeElement: element("IFRAME") },
      },
      { event: keyEvent("Escape"), context: { dialogActive: true } },
      { event: keyEvent("Escape", { isComposing: true }) },
      { event: keyEvent("Escape", { keyCode: 229 }) },
      { event: keyEvent("Escape", { repeat: true }) },
      { event: keyEvent("Escape", { altKey: true }) },
      { event: keyEvent("Escape", { ctrlKey: true }) },
      { event: keyEvent("Escape", { metaKey: true }) },
      { event: keyEvent("Escape", { shiftKey: true }) },
      { event: keyEvent("Escape", { defaultPrevented: true }) },
      {
        event: keyEvent("Escape"),
        context: {
          config: createLaunchShortcutConfiguration({ enabled: false }),
        },
      },
      {
        event: keyEvent("Escape"),
        context: {
          config: createLaunchShortcutConfiguration({
            bindings: { dismiss: null },
          }),
        },
      },
    ];

    for (const { context, event } of blocked) {
      expect(resolveLaunchShortcut(event, context)).toBeNull();
    }
  });

  it("ignores unknown keys and conservatively suppresses cyclic targets", () => {
    const cyclic = element("DIV");
    cyclic.parentElement = cyclic;

    expect(resolveLaunchShortcut(keyEvent("x"))).toBeNull();
    expect(isLaunchShortcutProtectedTarget(cyclic)).toBe(true);
    expect(resolveLaunchShortcut(keyEvent("k", { target: cyclic })))
      .toBeNull();
  });
});

describe("shortcut preference validation and remapping", () => {
  it("merges valid partial remaps, normalizes letters, and disables actions with null", () => {
    const result = validateLaunchShortcutPreferences({
      enabled: true,
      bindings: {
        search: "G",
        help: "/",
        dismiss: null,
      },
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.value.bindings.search).toBe("g");
    expect(result.value.bindings.help).toBe("/");
    expect(result.value.bindings.dismiss).toBeNull();
    expect(result.value.bindings.alerts).toBe("a");
    expect(resolveLaunchShortcut(keyEvent("g"), {
      config: result.value,
    })).toBe("search");
    expect(resolveLaunchShortcut(keyEvent("k"), {
      config: result.value,
    })).toBeNull();
    expect(resolveLaunchShortcut(keyEvent("Escape"), {
      config: result.value,
    })).toBeNull();
  });

  it("supports a global disable without mutating the canonical defaults", () => {
    const config = createLaunchShortcutConfiguration({ enabled: false });
    expect(config.enabled).toBe(false);
    expect(resolveLaunchShortcut(keyEvent("k"), { config })).toBeNull();
    expect(launchShortcutAriaKeyShortcuts("search", config)).toBeUndefined();
    expect(DEFAULT_LAUNCH_SHORTCUT_CONFIGURATION.enabled).toBe(true);
  });

  it.each([
    [null, "invalid_type"],
    [[], "invalid_type"],
    [{ surprise: true }, "unknown_field"],
    [{ enabled: "yes" }, "invalid_type"],
    [{ bindings: [] }, "invalid_type"],
    [{ bindings: { connect: "c" } }, "unknown_action"],
    [{ bindings: { search: "" } }, "invalid_key"],
    [{ bindings: { search: " " } }, "invalid_key"],
    [{ bindings: { search: "Control+K" } }, "invalid_key"],
    [{ bindings: { search: "+" } }, "invalid_key"],
    [{ bindings: { search: "A" } }, "duplicate_key"],
    [{ bindings: { search: "Escape" } }, "duplicate_key"],
  ] as const)("rejects invalid preference %#", (preferences, issueCode) => {
    const result = validateLaunchShortcutPreferences(preferences);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues.some((entry) => entry.code === issueCode)).toBe(true);
  });

  it("throws a typed error when callers require a valid configuration", () => {
    expect(() =>
      createLaunchShortcutConfiguration({
        bindings: { settings: "k" },
      })
    ).toThrow(LaunchShortcutConfigurationError);

    try {
      createLaunchShortcutConfiguration({
        bindings: { settings: "k" },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(LaunchShortcutConfigurationError);
      expect((error as LaunchShortcutConfigurationError).issues[0]?.code)
        .toBe("duplicate_key");
    }
  });
});

describe("shortcut integration helpers", () => {
  it("provides aria-keyshortcuts values separately from display labels", () => {
    expect(launchShortcutAriaKeyShortcuts("search")).toBe("k");
    expect(launchShortcutAriaKeyShortcuts("help")).toBe("?");
    expect(launchShortcutAriaKeyShortcuts("dismiss")).toBe("Escape");
    expect(launchShortcutDisplayLabel("search")).toBe("K");
    expect(launchShortcutDisplayLabel("help")).toBe("?");
    expect(launchShortcutDisplayLabel("dismiss")).toBe("Esc");

    const config = createLaunchShortcutConfiguration({
      bindings: { search: null },
    });
    expect(launchShortcutAriaKeyShortcuts("search", config)).toBeUndefined();
    expect(launchShortcutDisplayLabel("search", config)).toBeUndefined();
  });

  it("round-trips the visual Agent positions, including 0 as position 10", () => {
    for (let position = 1; position <= 10; position += 1) {
      const action = launchAgentShortcutAction(position);
      expect(action).toBe(`agent-${position}`);
      expect(launchAgentShortcutPosition(action!)).toBe(position);
    }
    expect(launchAgentShortcutAction(0)).toBeNull();
    expect(launchAgentShortcutAction(11)).toBeNull();
    expect(launchAgentShortcutAction(1.5)).toBeNull();
    expect(launchAgentShortcutPosition("search")).toBeNull();
    expect(
      DEFAULT_LAUNCH_SHORTCUT_CONFIGURATION.bindings["agent-10"],
    ).toBe("0");
  });
});
