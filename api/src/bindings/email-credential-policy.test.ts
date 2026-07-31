import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { ResolvedCredential } from "../../../shared/contracts/env.ts";
import { resolveManagedEmailCredentials } from "./email-credential-policy.ts";

function credentials(
  values: Record<string, string>,
): Record<string, ResolvedCredential> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      { value, vaulted: /_(?:PASS|PASSWORD)$/.test(key) },
    ]),
  );
}

Deno.test("managed email: strict IMAP variables and declared destination resolve", () => {
  assertEquals(
    resolveManagedEmailCredentials({
      protocol: "imap",
      hostKey: "SUPPORT_IMAP_HOST",
      userKey: "SUPPORT_IMAP_USERNAME",
      passKey: "SUPPORT_IMAP_PASSWORD",
      port: 993,
      credentials: credentials({
        SUPPORT_IMAP_HOST: "imap.example.com",
        SUPPORT_IMAP_USERNAME: "owner@example.com",
        SUPPORT_IMAP_PASSWORD: "not-echoed",
      }),
      allowedDestinations: ["imap.example.com:993"],
      strict: true,
    }),
    {
      host: "imap.example.com",
      user: "owner@example.com",
      pass: "not-echoed",
      port: 993,
    },
  );
});

Deno.test("managed email: strict SMTP permits a port-less destination declaration", () => {
  const result = resolveManagedEmailCredentials({
    protocol: "smtp",
    hostKey: "SMTP_HOST",
    userKey: "SMTP_USER",
    passKey: "SMTP_PASS",
    port: 465,
    credentials: credentials({
      SMTP_HOST: "smtp.example.com",
      SMTP_USER: "owner@example.com",
      SMTP_PASS: "not-echoed",
    }),
    allowedDestinations: ["smtp.example.com"],
    strict: true,
  });
  assertEquals(result.host, "smtp.example.com");
});

Deno.test("managed email: strict mode rejects unrelated or mixed credential keys", () => {
  const values = credentials({
    IMAP_HOST: "imap.example.com",
    IMAP_USER: "owner@example.com",
    API_TOKEN: "not-echoed",
    SMTP_PASS: "not-echoed-either",
  });
  for (const passKey of ["API_TOKEN", "SMTP_PASS"]) {
    const error = assertThrows(() =>
      resolveManagedEmailCredentials({
        protocol: "imap",
        hostKey: "IMAP_HOST",
        userKey: "IMAP_USER",
        passKey,
        port: 993,
        credentials: values,
        allowedDestinations: ["imap.example.com"],
        strict: true,
      })
    );
    assertEquals(String(error).includes("not-echoed"), false);
  }
});

Deno.test("managed email: strict mode rejects HTTP-bound secrets", () => {
  const values = credentials({
    IMAP_HOST: "imap.example.com",
    IMAP_USER: "owner@example.com",
    IMAP_PASS: "not-echoed",
  });
  values.IMAP_PASS.credential = {
    destination: "api.example.com",
    inject: { as: "bearer" },
  };
  const error = assertThrows(() =>
    resolveManagedEmailCredentials({
      protocol: "imap",
      hostKey: "IMAP_HOST",
      userKey: "IMAP_USER",
      passKey: "IMAP_PASS",
      port: 993,
      credentials: values,
      allowedDestinations: ["imap.example.com"],
      strict: true,
    })
  );
  assertEquals(String(error).includes("not-echoed"), false);
});

Deno.test("managed email: strict mode rejects a password exposed as ordinary config", () => {
  const values = credentials({
    IMAP_HOST: "imap.example.com",
    IMAP_USER: "owner@example.com",
    IMAP_PASS: "not-echoed",
  });
  values.IMAP_PASS.vaulted = false;
  const error = assertThrows(() =>
    resolveManagedEmailCredentials({
      protocol: "imap",
      hostKey: "IMAP_HOST",
      userKey: "IMAP_USER",
      passKey: "IMAP_PASS",
      port: 993,
      credentials: values,
      allowedDestinations: ["imap.example.com"],
      strict: true,
    })
  );
  assertEquals(String(error).includes("not-echoed"), false);
});

Deno.test("managed email: strict mode rejects undeclared hosts and ports", () => {
  const values = credentials({
    SMTP_HOST: "smtp.example.com",
    SMTP_USER: "owner@example.com",
    SMTP_PASS: "not-echoed",
  });
  for (const allowedDestinations of [[], ["smtp.example.com:587"]]) {
    const error = assertThrows(() =>
      resolveManagedEmailCredentials({
        protocol: "smtp",
        hostKey: "SMTP_HOST",
        userKey: "SMTP_USER",
        passKey: "SMTP_PASS",
        port: 465,
        credentials: values,
        allowedDestinations,
        strict: true,
      })
    );
    assertEquals(String(error).includes("not-echoed"), false);
  }
});

Deno.test("managed email: legacy manifests retain arbitrary historical key names", () => {
  assertEquals(
    resolveManagedEmailCredentials({
      protocol: "imap",
      hostKey: "MAIL_SERVER",
      userKey: "LOGIN",
      passKey: "SECRET",
      port: 993,
      credentials: credentials({
        MAIL_SERVER: "imap.example.com",
        LOGIN: "owner@example.com",
        SECRET: "not-echoed",
      }),
      allowedDestinations: [],
      strict: false,
    }).host,
    "imap.example.com",
  );
});

Deno.test("managed email: malformed ports fail before a socket can open", () => {
  const values = credentials({
    IMAP_HOST: "imap.example.com",
    IMAP_USER: "owner@example.com",
    IMAP_PASS: "not-echoed",
  });
  for (const port of [0, 1.5, 65_536, "993"]) {
    assertThrows(() =>
      resolveManagedEmailCredentials({
        protocol: "imap",
        hostKey: "IMAP_HOST",
        userKey: "IMAP_USER",
        passKey: "IMAP_PASS",
        port,
        credentials: values,
        allowedDestinations: ["imap.example.com"],
        strict: true,
      })
    );
  }
});
