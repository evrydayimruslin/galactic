import { describe, expect, it } from "vitest";

import {
  resolveOperatorAccessItem,
  resolveOperatorFunctionItem,
  resolveOperatorSettingsItem,
} from "./operator-item-targets";

describe("operator item targets", () => {
  const functions = [{
    name: "send_reply",
    inputSchema: {
      properties: {
        subject: { type: "string" },
        recipient: { type: "string" },
      },
    },
  }, {
    name: "send",
    inputSchema: { properties: { body: { type: "string" } } },
  }];

  it("resolves exact Functions and only published schema fields", () => {
    expect(resolveOperatorFunctionItem(functions, "send_reply")).toEqual({
      functionName: "send_reply",
      fieldName: null,
    });
    expect(resolveOperatorFunctionItem(functions, "send_reply.subject"))
      .toEqual({
        functionName: "send_reply",
        fieldName: "subject",
      });
    expect(resolveOperatorFunctionItem(functions, "send:body")).toEqual({
      functionName: "send",
      fieldName: "body",
    });
    expect(resolveOperatorFunctionItem(functions, "send_reply.unknown"))
      .toBeNull();
  });

  const access = [{
    id: "access:external:mail.google.com",
    credentials: [{ key: "GMAIL_TOKEN" }],
    settings: [],
    authority: [{
      id: "network:mail.google.com",
      actionId: null,
    }, {
      id: "routine:capability-1",
      actionId: "grant-1",
    }],
  }];

  it("normalizes Access settings, groups, authorities, and grant actions", () => {
    expect(resolveOperatorAccessItem(access, "setting:GMAIL_TOKEN")).toEqual({
      id: "GMAIL_TOKEN",
      kind: "setting",
      settingKey: "GMAIL_TOKEN",
    });
    expect(resolveOperatorAccessItem(access, "GMAIL_TOKEN")).toEqual({
      id: "GMAIL_TOKEN",
      kind: "setting",
      settingKey: "GMAIL_TOKEN",
    });
    expect(
      resolveOperatorAccessItem(
        access,
        "access:external:mail.google.com",
      ),
    ).toEqual({
      id: "access:external:mail.google.com",
      kind: "group",
    });
    expect(resolveOperatorAccessItem(access, "network:mail.google.com"))
      .toEqual({
        id: "network:mail.google.com",
        kind: "authority",
      });
    expect(resolveOperatorAccessItem(access, "grant:grant-1")).toEqual({
      id: "routine:capability-1",
      kind: "authority",
    });
    expect(resolveOperatorAccessItem(access, "missing")).toBeNull();
  });

  it("resolves static Settings sections and canonical release targets", () => {
    const release = {
      live: { version: "2.4.0" },
      candidate: { version: "2.5.0-rc.1" },
    };
    expect(resolveOperatorSettingsItem(release, "rate-limits")).toEqual({
      kind: "rate-limits",
    });
    expect(
      resolveOperatorSettingsItem(release, "release:2.4.0"),
    ).toEqual({
      kind: "release",
      version: "2.4.0",
    });
    expect(
      resolveOperatorSettingsItem(release, "release:2.5.0-rc.1"),
    ).toEqual({
      kind: "release",
      version: "2.5.0-rc.1",
    });
  });

  it("accepts an old raw release URL but rejects stale Settings items", () => {
    const release = {
      live: { version: "2.4.0" },
      candidate: null,
    };
    expect(resolveOperatorSettingsItem(release, "2.4.0")).toEqual({
      kind: "release",
      version: "2.4.0",
    });
    expect(resolveOperatorSettingsItem(release, "release:1.0.0")).toBeNull();
    expect(resolveOperatorSettingsItem(release, "unknown")).toBeNull();
  });
});
