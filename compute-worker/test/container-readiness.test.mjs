import { describe, expect, it } from "vitest";
import { verifyContainerReadiness } from "../scripts/verify-container-readiness.mjs";

const name = "galactic-compute-staging";
const image = `registry.cloudflare.com/${"a".repeat(32)}/${name}@sha256:${"b".repeat(64)}`;
const ready = {
  id: "app-id",
  name,
  state: "ready",
  instances: 0,
  image,
  version: 7,
  updated_at: "2026-07-20T00:00:00Z",
};

describe("Compute Container readiness gate", () => {
  it("accepts one ready or active application on the exact image", () => {
    expect(verifyContainerReadiness([ready], name, image)).toMatchObject({
      name,
      state: "ready",
      image,
      version: 7,
    });
    expect(() => verifyContainerReadiness([{ ...ready, state: "active" }], name, image)).not.toThrow();
  });

  it("rejects missing, duplicate, provisioning, and degraded applications", () => {
    expect(() => verifyContainerReadiness([], name, image)).toThrow(/exactly one/u);
    expect(() => verifyContainerReadiness([ready, ready], name, image)).toThrow(/exactly one/u);
    expect(() => verifyContainerReadiness([{ ...ready, state: "provisioning" }], name, image)).toThrow(/waiting/u);
    expect(() => verifyContainerReadiness([{ ...ready, state: "degraded" }], name, image)).toThrow(/waiting/u);
  });

  it("rejects a tag, wrong digest, or omitted application version", () => {
    expect(() => verifyContainerReadiness(
      [{ ...ready, image: image.replace(/b+$/u, "c".repeat(64)) }],
      name,
      image,
    )).toThrow(/released image digest/u);
    expect(() => verifyContainerReadiness([{ ...ready, version: null }], name, image)).toThrow(/version/u);
    expect(() => verifyContainerReadiness([{ ...ready, id: "" }], name, image)).toThrow(/ID/u);
    expect(() => verifyContainerReadiness([ready], name, `${name}:latest`)).toThrow(/exact/u);
  });
});
