import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

const cases = [
  {
    environment: "production",
    file: "wrangler.toml",
    maxInstances: 20,
    queueMaxConcurrency: 15,
    directHeadroom: 5,
  },
  {
    environment: "staging",
    file: "wrangler.staging.toml",
    maxInstances: 5,
    queueMaxConcurrency: 3,
    directHeadroom: 2,
  },
];

describe("Compute queue and Container capacity contract", () => {
  for (const expected of cases) {
    it(`reserves direct-job headroom in ${expected.environment}`, () => {
      const configPath = fileURLToPath(
        new URL(`../${expected.file}`, import.meta.url),
      );
      const config = unstable_readConfig(
        { config: configPath },
        { hideWarnings: true },
      );

      expect(config.containers).toHaveLength(1);
      expect(config.queues?.consumers).toHaveLength(1);
      expect(config.compatibility_flags).toContain(
        "global_fetch_strictly_public",
      );

      const maxInstances = config.containers?.[0]?.max_instances;
      const queueMaxConcurrency =
        config.queues?.consumers?.[0]?.max_concurrency;

      expect(maxInstances).toBe(expected.maxInstances);
      expect(queueMaxConcurrency).toBe(expected.queueMaxConcurrency);
      expect(queueMaxConcurrency).toBeLessThan(maxInstances);
      expect(maxInstances - queueMaxConcurrency).toBe(expected.directHeadroom);
    });
  }
});
