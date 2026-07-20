import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function fixture(path) {
  return readFileSync(
    fileURLToPath(new URL(`../images/standard/${path}`, import.meta.url)),
    "utf8",
  );
}

function repositoryFile(path) {
  return readFileSync(
    fileURLToPath(new URL(`../../${path}`, import.meta.url)),
    "utf8",
  );
}

describe("developer-v1 image contract", () => {
  it("pins the Sandbox image and lease MCP dependency", () => {
    const dockerfile = fixture("Dockerfile");
    const bridgePackage = JSON.parse(fixture("bridge/package.json"));
    const toolchainPackage = JSON.parse(fixture("toolchain/package.json"));
    expect(dockerfile).toContain("cloudflare/sandbox:0.12.3-python");
    expect(dockerfile).toContain('"playwright@${PLAYWRIGHT_VERSION}"');
    expect(dockerfile).toContain("/node_modules/playwright");
    expect(dockerfile).toContain("/node_modules/playwright-core");
    expect(toolchainPackage.dependencies.playwright).toBe(
      "1.62.0-alpha-2026-07-20",
    );
    expect(bridgePackage.dependencies["@modelcontextprotocol/sdk"]).toBe("1.29.0");
  });

  it("smokes the same ESM Playwright import a workspace job will use", () => {
    const smoke = readFileSync(
      fileURLToPath(new URL("../scripts/smoke-image.sh", import.meta.url)),
      "utf8",
    );
    expect(smoke).toContain('import { chromium } from "playwright"');
    expect(smoke).toContain(
      "accessSync(chromium.executablePath(), constants.X_OK)",
    );
    expect(smoke).toContain("await chromium.launch({ headless: true })");
    expect(smoke).toContain('browser.version() !== "151.0.7922.34"');
    expect(smoke).toContain('page.goto("data:text/html,<title>compute-smoke</title>")');
    expect(smoke).toContain("/node_modules/playwright-core");
  });

  it("bakes the local Compute-capable CLI with a pinned, offline Deno runtime", () => {
    const dockerfile = fixture("Dockerfile");
    const smoke = repositoryFile("compute-worker/scripts/smoke-image.sh");
    const cliEntry = repositoryFile("cli/bin/ultralight.js");
    const cliPackage = JSON.parse(repositoryFile("cli/package.json"));
    const toolchainPackage = JSON.parse(fixture("toolchain/package.json"));
    expect(cliPackage.version).toBe("2.4.0");
    expect(toolchainPackage.dependencies).not.toHaveProperty("galacticconnection");
    expect(dockerfile).toContain("ARG DENO_VERSION=2.9.3");
    expect(dockerfile).toContain(
      "8101865641cbede56f08ad19c0a67a87df84bce127fee0d3e3e1f7467717ffa6",
    );
    expect(dockerfile).toContain(
      "753937db98a4b56cbbbd26e8f00eb4b789191a229afec93f74bcfa4e79bc2c8b",
    );
    expect(dockerfile).toContain(
      "deno --version | awk 'NR == 1 { print $2 }'",
    );
    expect(dockerfile).toContain("COPY cli/package.json cli/package-lock.json");
    expect(dockerfile).toContain("deno cache --no-config --lock=/opt/galactic/cli/deno.lock --frozen");
    expect(cliEntry).toContain("--cached-only");
    expect(cliEntry).toContain("--no-config");
    expect(smoke).toContain("deno galactic galacticconnection");
    expect(smoke).toContain(
      'galactic budget --help | grep "conserved budget for the active Galactic Compute lease"',
    );
  });

  it("replaces inherited vulnerable runtimes without losing the Python data stack", () => {
    const dockerfile = fixture("Dockerfile");
    const smoke = repositoryFile("compute-worker/scripts/smoke-image.sh");
    const requirements = fixture("python/requirements.lock");
    for (const value of [
      "ARG PYTHON_VERSION=3.13.14",
      "3f031d431f80668e14f3bc066bbf4369cd9281b9",
      "771d12dda5140313db0ac550292987975651bbde",
      "7933f4bf7131aa4140750f9404f5de0aa2969ced",
      "LD_LIBRARY_PATH=/tmp/python-source",
      "./python -m test -u cpu test_tarfile test_htmlparser",
      "rm -rf /usr/local/python",
      "update-alternatives --remove python3 /usr/local/bin/python3.11",
      "ldconfig",
      "--only-binary=:all: --require-hashes",
    ]) {
      expect(dockerfile).toContain(value);
    }
    for (const direct of [
      "ipython==9.15.0",
      "matplotlib==3.11.0",
      "numpy==2.4.6",
      "pandas==3.0.3",
      "psutil==7.2.2",
    ]) {
      expect(requirements).toContain(direct);
    }
    const requirementLines = requirements
      .split("\n")
      .filter((line) => /^[a-z0-9][a-z0-9-]*==/u.test(line));
    expect(requirementLines).toHaveLength(29);
    expect(requirementLines.every((line) => line.endsWith(" \\"))).toBe(true);
    expect(smoke).toContain('test "$(/usr/bin/python3 --version)" = "Python 3.13.14"');
    expect(smoke).toContain("import IPython, matplotlib, numpy, pandas, psutil");
  });

  it("rebuilds static Go CLIs with patched modules and removes quick tunnels", () => {
    const dockerfile = fixture("Dockerfile");
    const overlay = fixture("overlays/git-lfs-v3.7.1-go-modules.patch");
    const smoke = repositoryFile("compute-worker/scripts/smoke-image.sh");
    expect(dockerfile).toContain(
      "golang:1.26.5-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651",
    );
    expect(dockerfile).toContain("ARG GH_VERSION=2.96.0");
    expect(dockerfile).toContain("ARG GIT_LFS_VERSION=3.7.1");
    expect(dockerfile).toContain("ARG GALACTIC_RCLONE_VERSION=1.74.4");
    expect(dockerfile).not.toContain("ARG RCLONE_VERSION=");
    expect(dockerfile).toContain("go/version: go1.26.5");
    expect(smoke).toContain("go/version: go1.26.5");
    for (const version of ["v0.53.0", "v0.56.0", "v0.21.0", "v0.46.0", "v0.38.0"]) {
      expect(overlay).toContain(version);
    }
    expect(dockerfile).not.toMatch(/\bgit git-lfs gh openssh-client\b/u);
    expect(dockerfile).not.toMatch(/^\s+rclone \\\s*$/mu);
    expect(dockerfile).toContain("rm -f /usr/local/bin/cloudflared");
    expect(smoke).toContain("test ! -e /usr/local/bin/cloudflared");
  });

  it("pins official DuckDB v1.5.1 release hashes for both supported architectures", () => {
    const dockerfile = fixture("Dockerfile");
    expect(dockerfile).toContain(
      "duckdb_sha=88e2ef7b47a384eef1c40d43cb863608cec4f49b72ff11fb277f9075c43670bc",
    );
    expect(dockerfile).toContain(
      "duckdb_sha=75e7e750426c1905aa8d0679634616ac2fb217e0004072fb26d176d100a15a27",
    );
  });

  it("uses a root build context with a deny-by-default allowlist", () => {
    const productionConfig = repositoryFile("compute-worker/wrangler.toml");
    const stagingConfig = repositoryFile("compute-worker/wrangler.staging.toml");
    const buildScript = repositoryFile("compute-worker/scripts/build-image.sh");
    const workflow = repositoryFile(".github/workflows/compute-ci.yml");
    const dockerignore = repositoryFile(".dockerignore");
    for (const config of [productionConfig, stagingConfig]) {
      expect(config).toContain('image_build_context = ".."');
    }
    expect(buildScript).toContain("--file images/standard/Dockerfile");
    expect(workflow.match(/- '\.dockerignore'/g)).toHaveLength(2);
    expect(workflow).toContain("--file images/standard/Dockerfile");
    expect(dockerignore.trimStart()).toMatch(/^#/);
    expect(dockerignore).toContain("\n**\n");
    expect(dockerignore).toContain("!cli/package-lock.json");
    expect(dockerignore).not.toContain("!.env");
    expect(dockerignore).not.toContain("!.git/");
  });

  it("does not hand the lease bearer to an independently published CLI", () => {
    const gx = fixture("gx.mjs");
    expect(gx).toContain("/opt/galactic/bridge/gx-mcp.mjs");
    expect(gx).not.toContain('GALACTIC_TOKEN: token()');
    expect(gx).not.toContain('spawn("galacticconnection"');
  });

  it("locks gx to the private gateway and integrity-checks bounded uploads", () => {
    const gx = fixture("gx.mjs");
    expect(gx).toContain('const gateway = "https://galactic.internal/v1"');
    expect(gx).toContain('const tokenFile = "/run/galactic/job-token"');
    expect(gx).toContain('realpathSync("/workspace")');
    expect(gx).toContain('createHash("sha256")');
    expect(gx).toContain('"x-galactic-sha256": sha256');
    expect(gx).toContain('"content-length": String(stats.size)');
    expect(gx).toContain("constants.O_NOFOLLOW");
    expect(gx).not.toContain("process.env.GALACTIC_GATEWAY_URL");
    expect(gx).not.toContain("process.env.GALACTIC_JOB_TOKEN_FILE");
  });

  it("has no public API or persistent-auth fallback in the body MCP bridge", () => {
    const bridge = fixture("bridge/gx-mcp.mjs");
    expect(bridge).toContain("https://galactic.internal/v1");
    expect(bridge).toContain('realpathSync("/workspace")');
    expect(bridge).toContain("constants.O_NOFOLLOW");
    expect(bridge).toContain("MAX_LOCAL_READ_BYTES");
    expect(bridge).toContain("MAX_LOCAL_WRITE_BYTES");
    expect(bridge).not.toContain("api.connectgalactic.com");
    expect(bridge).not.toContain(".galactic");
    expect(bridge).not.toContain("GALACTIC_TOKEN");
    expect(bridge).not.toContain("GALACTIC_API_TOKEN");
    expect(bridge).not.toContain("process.env.GALACTIC_GATEWAY_URL");
    expect(bridge).not.toContain("process.env.GALACTIC_JOB_TOKEN_FILE");
  });

  it("scrubs ambient platform, provider, cloud, and source-host credentials", () => {
    const entrypoint = fixture("entrypoint.sh");
    for (const name of [
      "GALACTIC_PLATFORM_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "CLOUDFLARE_API_TOKEN",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
    ]) {
      expect(entrypoint).toContain(name);
    }
  });

  it("does not stage unsigned toolpacks in v1", () => {
    const executor = readFileSync(
      fileURLToPath(new URL("../src/executor.ts", import.meta.url)),
      "utf8",
    );
    expect(executor).toContain("developer-v1 does not accept toolpacks");
    expect(executor).not.toContain("stageToolpacks");
    expect(executor).not.toContain("tar --extract");
  });

  it("uses supported host globs instead of inert CIDR notation", () => {
    const worker = readFileSync(
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
      "utf8",
    );
    const egress = readFileSync(
      fileURLToPath(new URL("../src/egress.ts", import.meta.url)),
      "utf8",
    );
    for (const pattern of [
      "10.*",
      "127.*",
      "169.254.*",
      "192.168.*",
      "[::1]",
      "[fc*",
      "[fe8*",
    ]) {
      expect(egress).toContain(`"${pattern}"`);
    }
    expect(egress).not.toMatch(/"(?:\d{1,3}\.){3}\d{1,3}\/\d+"/);
    expect(egress).not.toMatch(/"[0-9a-f:]+\/\d+"/i);
    expect(egress).toContain('redirect: "manual"');
    expect(worker).toContain("HTTP_INTERCEPT_DENIED_HOST_PATTERNS");
    expect(worker).toContain("enableInternet = false");
    expect(worker).not.toMatch(/\ballowedHosts\s*=/);
    expect(worker).toContain('"galactic.internal"');
    expect(worker).toContain("outboundByHost");
    expect(worker).toContain("ComputeStandard.outboundByHost =");
    expect(worker).toContain("ComputeStandard.outbound =");
    expect(worker).not.toMatch(/static\s+outbound(?:ByHost)?\s*=/);
  });
});

describe("Compute release supply-chain contract", () => {
  it("fails every critical and every fixable high vulnerability", () => {
    const scanner = repositoryFile("compute-worker/scripts/scan-sbom.sh");
    expect(scanner).toContain('.vulnerability.severity == "Critical"');
    expect(scanner).toContain("grype-critical-findings.json");
    expect(scanner).toContain("--only-fixed --fail-on high");
    expect(scanner.match(/--vex "\$vex_document"/gu)).toHaveLength(2);
    expect(scanner).toContain(".ignoredMatches[]?");
    expect(scanner).toContain("grype-vex-ignored-findings.json");
    expect(scanner).toContain('artifact.purl == "pkg:generic/python@3.13.14"');
  });

  it("limits VEX to the three exact tested CPython backports", () => {
    const vex = JSON.parse(
      repositoryFile(
        "compute-worker/security/cpython-3.13.14-security-backports.openvex.json",
      ),
    );
    expect(vex["@context"]).toBe("https://openvex.dev/ns/v0.2.0");
    expect(vex.statements).toHaveLength(3);
    const expected = new Map([
      [
        "CVE-2026-11972",
        [
          "3f031d431f80668e14f3bc066bbf4369cd9281b9",
          "240177f6a8e0e328773cb775add1f2cfe9128e67d461a9ba728fbb3cbbe89086",
        ],
      ],
      [
        "CVE-2026-11940",
        [
          "771d12dda5140313db0ac550292987975651bbde",
          "f74e92f1eb84a91b3efc144660d9e59162d81a922bb9ecccb2e64b832c91d387",
        ],
      ],
      [
        "CVE-2026-15308",
        [
          "7933f4bf7131aa4140750f9404f5de0aa2969ced",
          "d8913b46e769704d0e810994909ee81c8af6aaa7230b79ff4c0d849fe1f305a4",
        ],
      ],
    ]);
    for (const statement of vex.statements) {
      const [commit, patchSha] = expected.get(statement.vulnerability.name) ?? [];
      expect(commit).toBeTruthy();
      expect(statement.products).toEqual([
        { "@id": "pkg:generic/python@3.13.14" },
      ]);
      expect(statement.status).toBe("fixed");
      expect(statement.status_notes).toContain(commit);
      expect(statement.status_notes).toContain(patchSha);
    }
    expect(new Set(vex.statements.map((statement) => statement.vulnerability.name))).toEqual(
      new Set(expected.keys()),
    );
  });

  it("keeps Cloudflare deploy credentials off untrusted build/install steps", () => {
    const workflow = repositoryFile(".github/workflows/compute-deploy.yml");
    const jobHeader = workflow.slice(0, workflow.indexOf("    steps:"));
    const install = workflow.slice(
      workflow.indexOf("- name: Install dependencies"),
      workflow.indexOf("- name: Verify Compute and API integration"),
    );
    const imageBuild = workflow.slice(
      workflow.indexOf("- name: Build and smoke exact image"),
      workflow.indexOf("- name: Generate image SBOM"),
    );
    expect(jobHeader).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(jobHeader).not.toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(install).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(imageBuild).not.toContain("CLOUDFLARE_API_TOKEN");
  });

  it("keeps API deploy credentials out of dependency lifecycle steps", () => {
    const workflow = repositoryFile(".github/workflows/api-deploy.yml");
    for (const jobName of ["deploy_staging", "deploy_production"]) {
      const jobStart = workflow.indexOf(`  ${jobName}:`);
      const stepsStart = workflow.indexOf("    steps:", jobStart);
      expect(jobStart).toBeGreaterThan(-1);
      expect(workflow.slice(jobStart, stepsStart)).not.toContain(
        "CLOUDFLARE_API_TOKEN",
      );
    }
    for (const stepName of [
      "Install dependencies",
      "Install staging capacity Tail dependencies",
      "Install production capacity Tail dependencies",
    ]) {
      const start = workflow.indexOf(`- name: ${stepName}`);
      const end = workflow.indexOf("\n      - name:", start + 1);
      expect(start).toBeGreaterThan(-1);
      expect(workflow.slice(start, end < 0 ? undefined : end)).not.toContain(
        "CLOUDFLARE_API_TOKEN",
      );
    }
  });

  it("pins every third-party action in Compute provenance workflows to a full commit", () => {
    for (const path of [
      ".github/workflows/compute-ci.yml",
      ".github/workflows/compute-deploy.yml",
      ".github/workflows/compute-admission.yml",
      ".github/workflows/api-deploy.yml",
    ]) {
      const workflow = repositoryFile(path);
      const uses = workflow.match(/uses:\s+([^\s#]+)/g) ?? [];
      expect(uses.length).toBeGreaterThan(0);
      for (const value of uses) {
        expect(value).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  it("keeps admission manual, canary-only, digest-bound, and independently reviewed", () => {
    const workflow = repositoryFile(
      ".github/workflows/compute-admission.yml",
    );
    const triggers = workflow.slice(
      workflow.indexOf("on:"),
      workflow.indexOf("permissions:"),
    );
    expect(triggers).toContain("workflow_dispatch:");
    expect(triggers).not.toContain("push:");
    expect(triggers).not.toContain("pull_request:");
    expect(workflow).toContain("default: disable");
    expect(workflow).toContain("DISABLE GALACTIC COMPUTE");
    expect(workflow).toContain("ENABLE GALACTIC COMPUTE CANARY");
    expect(workflow).toContain("environment: ${{ inputs.target }}");
    expect(workflow).toContain('.type == "required_reviewers"');
    expect(workflow).toContain(".prevent_self_review == true");
    expect(workflow).toContain(".can_admins_bypass == false");
    expect(workflow).toContain("COMPUTE_ROLLOUT_MODE:canary");
    expect(workflow).not.toContain("COMPUTE_ROLLOUT_MODE:global");
    expect(workflow).toContain("RELEASE_ENVIRONMENT_DIGEST");
    expect(workflow).toContain("CERTIFIED_OFF_API_VERSION_ID");
    expect(workflow).toContain("CERTIFIED_COMPUTE_VERSION_ID");
    expect(workflow).toContain("compute_release_run_id:");
    expect(workflow).toContain("gh run download");
    expect(workflow).toContain('migrations !== "true"');
    expect(workflow).toContain("value_read: false");
    expect(workflow).toContain("--strict");
    expect(workflow).toContain('--tag "api-$GITHUB_SHA"');
    expect(workflow).toContain(
      'versions deploy "$CERTIFIED_OFF_API_VERSION_ID@100%"',
    );
    expect(workflow).toContain(
      "Promote certified OFF version after any ambiguous attempted change",
    );
    expect(workflow).not.toContain("api-compute-admission-disable.toml");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("Upload admission audit evidence");
  });

  it("certifies tagged API and Compute versions before admission", () => {
    const release = repositoryFile(".github/workflows/compute-deploy.yml");
    const apiDeploy = repositoryFile(".github/workflows/api-deploy.yml");
    expect(release).toContain('--tag "compute-$GITHUB_SHA"');
    expect(release).toContain('--tag "api-$GITHUB_SHA"');
    expect(release).toContain("certified_admission_off_api");
    expect(release).toContain("active_compute_worker");
    expect(release).toContain("API is not one stable 100% version");
    expect(release).toContain("Compute is not one stable 100% version");
    expect(release).toContain('value("COMPUTE_ENABLED") == "0"');
    expect(release).toContain('value("COMPUTE_CANARY_ALLOWLIST") == ""');
    expect(apiDeploy.match(/--tag "api-\$GITHUB_SHA"/g)?.length).toBe(2);
    expect(apiDeploy.match(/persist-credentials: false/g)?.length).toBe(3);
    expect(apiDeploy).toContain(
      "a7c9d5c1f93bfaabe03c3c0583a8c88caf695db3cec4dea2938440038609f225",
    );
    expect(apiDeploy).toContain("sha256sum -c -");
    expect(release).toContain("persist-credentials: false");
  });

  it("keeps artifact deletion database-driven instead of object-age-driven", () => {
    const workflow = repositoryFile(".github/workflows/compute-deploy.yml");
    const runbook = repositoryFile("docs/GALACTIC_COMPUTE_RUNBOOK.md");
    expect(workflow).toContain(
      "/r2/buckets/$ARTIFACT_BUCKET/lifecycle",
    );
    expect(workflow).toContain("scripts/verify-r2-lifecycle.mjs");
    expect(workflow).not.toContain("compute-runs-7d");
    expect(workflow).not.toContain("compute-runs-30d");
    expect(runbook).not.toMatch(/compute-v1\/\s+--expire-days/u);
    expect(runbook).toContain(
      "_galactic-control/v1/compute-finalization/ --expire-days 1",
    );
    expect(runbook).toContain("database state and the reconciler");
  });

  it("requires a dedicated Compute emergency-stop edge credential", () => {
    const workflow = repositoryFile(".github/workflows/compute-deploy.yml");
    const runbook = repositoryFile("docs/GALACTIC_COMPUTE_RUNBOOK.md");
    const devVars = repositoryFile("api/.dev.vars.example");
    expect(workflow).toContain("COMPUTE_EMERGENCY_STOP_TOKEN");
    expect(workflow).toContain("any(.[]; .name == $name)");
    expect(devVars).toContain("COMPUTE_JOB_TOKEN_PEPPER=");
    expect(devVars).toContain("COMPUTE_EMERGENCY_STOP_TOKEN=");
    expect(runbook).toContain(
      "Authorization: Bearer ${COMPUTE_EMERGENCY_STOP_TOKEN}",
    );
    expect(runbook).not.toContain(
      "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}",
    );
  });
});
