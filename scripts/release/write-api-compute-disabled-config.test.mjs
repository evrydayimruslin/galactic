import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeDisabledApiConfig,
} from "./write-api-compute-disabled-config.mjs";

const fixture = `
name = "api"

[[r2_buckets]]
binding = "R2_BUCKET"
bucket_name = "apps"

[[r2_buckets]]
binding = "COMPUTE_ARTIFACTS"
bucket_name = "compute-artifacts"

[[services]]
binding = "SELF"
service = "api"

[[services]]
binding = "COMPUTE_PLANE"
service = "compute"
entrypoint = "ComputePlane"

[[queues.producers]]
binding = "EXEC_QUEUE"
queue = "exec"

[[queues.producers]]
binding = "COMPUTE_QUEUE"
queue = "compute"

[[queues.consumers]]
queue = "galactic-compute-dlq"
dead_letter_queue = "galactic-compute-reconciliation-dlq"

[vars]
COMPUTE_ENABLED = "0"

[[env.staging.r2_buckets]]
binding = "R2_BUCKET"
bucket_name = "apps"

[[env.staging.r2_buckets]]
binding = "COMPUTE_ARTIFACTS"
bucket_name = "compute-artifacts-staging"

[[env.staging.services]]
binding = "SELF"
service = "api-staging"

[[env.staging.services]]
binding = "COMPUTE_PLANE"
service = "compute-staging"
entrypoint = "ComputePlane"

[[env.staging.queues.producers]]
binding = "EXEC_QUEUE"
queue = "exec-staging"

[[env.staging.queues.producers]]
binding = "COMPUTE_QUEUE"
queue = "compute-staging"

[[env.staging.queues.consumers]]
queue = "galactic-compute-staging-dlq"
dead_letter_queue = "galactic-compute-staging-reconciliation-dlq"

[env.staging.vars]
COMPUTE_ENABLED = "0"
`;

test("removes only the reviewed production and staging Compute bindings", () => {
  const output = computeDisabledApiConfig(fixture);

  assert.doesNotMatch(output, /COMPUTE_PLANE/u);
  assert.match(output, /binding = "COMPUTE_ARTIFACTS"/u);
  assert.match(output, /binding = "COMPUTE_QUEUE"/u);
  assert.match(output, /queue = "galactic-compute-dlq"/u);
  assert.match(output, /queue = "galactic-compute-staging-dlq"/u);
  assert.match(output, /binding = "R2_BUCKET"/u);
  assert.match(output, /binding = "SELF"/u);
  assert.match(output, /binding = "EXEC_QUEUE"/u);
  assert.equal(
    output.match(/COMPUTE_ENABLED = "0"/gu)?.length,
    2,
  );
});

test("fails closed when a reviewed Compute binding is absent", () => {
  assert.throws(
    () =>
      computeDisabledApiConfig(
        fixture.replace(
          /\[\[services\]\]\nbinding = "COMPUTE_PLANE"[\s\S]*?entrypoint = "ComputePlane"\n/u,
          "",
        ),
      ),
    /Expected exactly the reviewed Compute-only bindings/u,
  );
});

test("fails closed when a reviewed Compute binding is duplicated", () => {
  const duplicate = `
[[services]]
binding = "COMPUTE_PLANE"
service = "another-compute"
entrypoint = "ComputePlane"
`;
  assert.throws(
    () => computeDisabledApiConfig(`${fixture}${duplicate}`),
    /Expected exactly the reviewed Compute-only bindings/u,
  );
});
