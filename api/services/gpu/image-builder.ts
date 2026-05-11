// GPU Image Builder — GHCR + GitHub Actions orchestration.
//
// This service creates a deterministic Docker build context from developer
// GPU files, stores it behind an unguessable internal URL, and dispatches a
// GitHub Actions workflow that builds and pushes the final image to GHCR.

import { getEnv } from "../../lib/env.ts";
import { createR2Service } from "../storage.ts";
import type { GpuBaseProfile, GpuConfig } from "./types.ts";
import { GPU_BAKED_HARNESS_PY } from "./harness-source.ts";

const DEFAULT_CONTEXT_TTL_SECONDS = 60 * 60;
const DEFAULT_BUILD_REF = "main";
const DEFAULT_BUILD_REPO = "ultralight-run/ultralight-gpu-builds";
const DEFAULT_WORKFLOW_ID = "gpu-image-build.yml";
const DEFAULT_IMAGE_NAMESPACE = "ghcr.io/ultralight/gpu-apps";
const DEFAULT_PYTHON_CUDA_IMAGE =
  "ghcr.io/ultralight/gpu-bases/python-cuda:py3.11-cuda12.4";
const DEFAULT_TORCH_CUDA_IMAGE =
  "ghcr.io/ultralight/gpu-bases/torch-cuda:py3.11-torch2.5-cuda12.4";

const textEncoder = new TextEncoder();

export interface GpuImageBuildConfig {
  repository: string;
  workflowId: string;
  ref: string;
  imageNamespace: string;
  contextTtlSeconds: number;
  pythonCudaBaseImage: string;
  torchCudaBaseImage: string;
  callbackSecret: string;
  authMode: "token" | "github_app";
}

export interface GpuImageBuildReadiness {
  ok: boolean;
  missing: string[];
  config?: GpuImageBuildConfig;
}

export interface DispatchGpuImageBuildParams {
  appId: string;
  version: string;
  files: Array<{ name: string; content: string }>;
  config: GpuConfig;
  buildLogs?: string[];
}

export interface DispatchGpuImageBuildResult {
  buildId: string;
  contextKey: string;
  targetImage: string;
  baseImage: string;
  dockerfile: string;
  contextUrl: string;
  callbackUrl: string;
  expiresAt: string;
}

export interface GpuImageBuildCallbackPayload {
  build_id?: string;
  app_id?: string;
  version?: string;
  status?: string;
  image_ref?: string;
  image_digest?: string;
  image_size_bytes?: number;
  build_seconds?: number;
  error?: string;
  logs_url?: string;
}

interface StoredBuildContextMetadata {
  app_id: string;
  version: string;
  build_id: string;
  target_image: string;
  base_profile: GpuBaseProfile;
  created_at: string;
  expires_at: string;
}

interface GithubWorkflowDispatchPayload {
  ref: string;
  inputs: Record<string, string>;
}

export function resolveGpuImageBuildReadiness(): GpuImageBuildReadiness {
  const missing: string[] = [];

  const repository = getEnv("GITHUB_BUILD_REPO") || DEFAULT_BUILD_REPO;
  const workflowId = getEnv("GITHUB_BUILD_WORKFLOW_ID") || DEFAULT_WORKFLOW_ID;
  const ref = getEnv("GITHUB_BUILD_REF") || DEFAULT_BUILD_REF;
  const imageNamespace = normalizeImageNamespace(
    getEnv("GHCR_IMAGE_NAMESPACE") || DEFAULT_IMAGE_NAMESPACE,
  );
  const pythonCudaBaseImage = getEnv("GPU_BASE_IMAGE_PYTHON_CUDA") ||
    DEFAULT_PYTHON_CUDA_IMAGE;
  const torchCudaBaseImage = getEnv("GPU_BASE_IMAGE_TORCH_CUDA") ||
    DEFAULT_TORCH_CUDA_IMAGE;
  const callbackSecret = getEnv("GPU_BUILD_CALLBACK_SECRET");

  if (!repository) missing.push("GITHUB_BUILD_REPO");
  if (!workflowId) missing.push("GITHUB_BUILD_WORKFLOW_ID");
  if (!ref) missing.push("GITHUB_BUILD_REF");
  if (!imageNamespace) missing.push("GHCR_IMAGE_NAMESPACE");
  if (!pythonCudaBaseImage) missing.push("GPU_BASE_IMAGE_PYTHON_CUDA");
  if (!torchCudaBaseImage) missing.push("GPU_BASE_IMAGE_TORCH_CUDA");
  if (!callbackSecret) missing.push("GPU_BUILD_CALLBACK_SECRET");

  const token = getEnv("GITHUB_ACTIONS_TOKEN") || getEnv("GITHUB_BUILD_TOKEN");
  const hasGithubAppAuth = Boolean(
    getEnv("GITHUB_APP_ID") &&
      getEnv("GITHUB_APP_PRIVATE_KEY") &&
      getEnv("GITHUB_INSTALLATION_ID"),
  );
  if (!token && !hasGithubAppAuth) {
    missing.push(
      "GITHUB_ACTIONS_TOKEN or GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY/GITHUB_INSTALLATION_ID",
    );
  }

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  const contextTtlSeconds = parsePositiveInt(
    getEnv("GPU_BUILD_CONTEXT_TTL_SECONDS"),
    DEFAULT_CONTEXT_TTL_SECONDS,
  );

  return {
    ok: true,
    missing: [],
    config: {
      repository,
      workflowId,
      ref,
      imageNamespace,
      contextTtlSeconds,
      pythonCudaBaseImage,
      torchCudaBaseImage,
      callbackSecret,
      authMode: token ? "token" : "github_app",
    },
  };
}

export async function dispatchGpuImageBuild(
  params: DispatchGpuImageBuildParams,
): Promise<DispatchGpuImageBuildResult> {
  const readiness = resolveGpuImageBuildReadiness();
  if (!readiness.ok || !readiness.config) {
    throw new Error(
      `GPU image build is not configured. Missing: ${
        readiness.missing.join(", ")
      }`,
    );
  }

  const buildConfig = readiness.config;
  const baseProfile = params.config.base || "python-cuda";
  const baseImage = resolveBaseImage(params.config, buildConfig);
  const targetImage = buildTargetImageRef(
    params.appId,
    params.version,
    buildConfig.imageNamespace,
  );
  const dockerfile = generateGpuImageDockerfile({
    baseImage,
    appId: params.appId,
    version: params.version,
  });

  const buildId = crypto.randomUUID();
  const createdAt = new Date();
  const expiresAt = new Date(
    createdAt.getTime() + buildConfig.contextTtlSeconds * 1000,
  ).toISOString();
  const token = crypto.randomUUID().replaceAll("-", "") +
    crypto.randomUUID().replaceAll("-", "");
  const contextKey = getBuildContextKey(params.appId, params.version, token);
  const metadataKey = getBuildContextMetadataKey(
    params.appId,
    params.version,
    token,
  );

  const contextFiles = createBuildContextFiles(params.files, dockerfile);
  const tar = createTarArchive(contextFiles);
  const r2 = createR2Service();

  await r2.uploadFile(contextKey, {
    name: "context.tar",
    content: tar,
    contentType: "application/x-tar",
  });
  await r2.uploadFile(metadataKey, {
    name: "metadata.json",
    content: textEncoder.encode(JSON.stringify(
      {
        app_id: params.appId,
        version: params.version,
        build_id: buildId,
        target_image: targetImage,
        base_profile: baseProfile,
        created_at: createdAt.toISOString(),
        expires_at: expiresAt,
      } satisfies StoredBuildContextMetadata,
    )),
    contentType: "application/json",
  });

  const baseUrl = getPlatformBaseUrl();
  const contextUrl =
    `${baseUrl}/internal/gpu/build-context/${params.appId}/${params.version}/${token}`;
  const callbackUrl = `${baseUrl}/internal/gpu/build-callback`;

  const githubToken = await resolveGithubActionsToken();
  await dispatchGithubWorkflow(buildConfig, githubToken, {
    build_id: buildId,
    app_id: params.appId,
    version: params.version,
    context_url: contextUrl,
    callback_url: callbackUrl,
    target_image: targetImage,
    base_profile: baseProfile,
  });

  params.buildLogs?.push(`[build] GHCR image build dispatched: ${buildId}`);
  params.buildLogs?.push(`[build] Target image: ${targetImage}`);
  params.buildLogs?.push(`[build] Base image: ${baseImage}`);

  return {
    buildId,
    contextKey,
    targetImage,
    baseImage,
    dockerfile,
    contextUrl,
    callbackUrl,
    expiresAt,
  };
}

export async function fetchGpuBuildContext(
  appId: string,
  version: string,
  token: string,
): Promise<{ content: Uint8Array; metadata: StoredBuildContextMetadata }> {
  if (!appId || !version || !isBuildContextToken(token)) {
    throw new Error("Invalid GPU build context token");
  }

  const r2 = createR2Service();
  const metadataText = await r2.fetchTextFile(
    getBuildContextMetadataKey(appId, version, token),
  );
  const metadata = JSON.parse(metadataText) as StoredBuildContextMetadata;

  if (
    metadata.app_id !== appId ||
    metadata.version !== version ||
    !metadata.expires_at
  ) {
    throw new Error("Invalid GPU build context metadata");
  }

  if (Date.now() > Date.parse(metadata.expires_at)) {
    throw new Error("GPU build context expired");
  }

  const content = await r2.fetchFile(getBuildContextKey(appId, version, token));
  return { content, metadata };
}

export function verifyGpuBuildCallbackSecret(request: Request): boolean {
  const expected = getEnv("GPU_BUILD_CALLBACK_SECRET");
  if (!expected) return false;
  const provided = request.headers.get("X-GPU-Build-Secret") ||
    request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ||
    "";
  return timingSafeEqual(expected, provided);
}

export function resolveBaseImage(
  config: GpuConfig,
  buildConfig = resolveGpuImageBuildReadiness().config,
): string {
  if (!buildConfig) {
    throw new Error("GPU image build config is unavailable");
  }
  return (config.base || "python-cuda") === "torch-cuda"
    ? buildConfig.torchCudaBaseImage
    : buildConfig.pythonCudaBaseImage;
}

export function buildTargetImageRef(
  appId: string,
  version: string,
  namespace = getEnv("GHCR_IMAGE_NAMESPACE") || DEFAULT_IMAGE_NAMESPACE,
): string {
  const normalizedAppId = appId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const normalizedVersion = version.toLowerCase().replace(
    /[^a-z0-9._-]+/g,
    "-",
  );
  return `${
    normalizeImageNamespace(namespace)
  }/${normalizedAppId}:${normalizedVersion}`;
}

export function generateGpuImageDockerfile(input: {
  baseImage: string;
  appId: string;
  version: string;
}): string {
  return [
    "# Ultralight GPU image — generated by the platform",
    `# App: ${input.appId}@${input.version}`,
    `# Generated: ${new Date().toISOString()}`,
    `FROM ${input.baseImage}`,
    "",
    "ENV PYTHONUNBUFFERED=1 \\",
    "    ULTRALIGHT_BAKED_IMAGE=1",
    "",
    "WORKDIR /app",
    "",
    "COPY requirements.txt /tmp/requirements.txt",
    "RUN if [ -s /tmp/requirements.txt ]; then \\",
    "      pip install --no-cache-dir -r /tmp/requirements.txt; \\",
    "    fi",
    "",
    "COPY . /app",
    "COPY harness.py /app/harness.py",
    "",
    'CMD ["python", "-u", "/app/harness.py"]',
    "",
  ].join("\n");
}

function createBuildContextFiles(
  files: Array<{ name: string; content: string }>,
  dockerfile: string,
): Array<{ name: string; content: Uint8Array }> {
  const entries = new Map<string, Uint8Array>();

  for (const file of files) {
    const name = normalizeBuildPath(file.name);
    if (!name) continue;

    const lowerName = name.toLowerCase();
    if (lowerName === "dockerfile" || name === "harness.py") {
      continue;
    }
    entries.set(name, textEncoder.encode(file.content));
  }

  if (!entries.has("requirements.txt")) {
    entries.set("requirements.txt", new Uint8Array());
  }

  entries.set("Dockerfile", textEncoder.encode(dockerfile));
  entries.set("harness.py", textEncoder.encode(GPU_BAKED_HARNESS_PY));

  return [...entries.entries()].map(([name, content]) => ({ name, content }));
}

function createTarArchive(
  files: Array<{ name: string; content: Uint8Array }>,
): Uint8Array {
  const chunks: Uint8Array[] = [];

  for (const file of files) {
    const header = createTarHeader(file.name, file.content.length);
    chunks.push(header);
    chunks.push(file.content);
    const paddingLength = (512 - (file.content.length % 512)) % 512;
    if (paddingLength > 0) {
      chunks.push(new Uint8Array(paddingLength));
    }
  }

  chunks.push(new Uint8Array(1024));

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const archive = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }
  return archive;
}

function createTarHeader(path: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  const now = Math.floor(Date.now() / 1000);
  const { name, prefix } = splitTarPath(path);

  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, now);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");
  if (prefix) {
    writeTarString(header, 345, 155, prefix);
  }

  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumString = checksum.toString(8).padStart(6, "0");
  writeTarString(header, 148, 6, checksumString);
  header[154] = 0;
  header[155] = 0x20;

  return header;
}

function splitTarPath(path: string): { name: string; prefix: string } {
  if (textEncoder.encode(path).length <= 100) {
    return { name: path, prefix: "" };
  }

  const parts = path.split("/");
  const name = parts.pop() || "";
  const prefix = parts.join("/");
  if (
    textEncoder.encode(name).length > 100 ||
    textEncoder.encode(prefix).length > 155
  ) {
    throw new Error(`GPU build file path too long for tar archive: ${path}`);
  }
  return { name, prefix };
}

function writeTarString(
  header: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = textEncoder.encode(value);
  header.set(bytes.slice(0, length), offset);
}

function writeTarOctal(
  header: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const stringValue = value.toString(8).padStart(length - 1, "0");
  writeTarString(header, offset, length - 1, stringValue);
}

async function dispatchGithubWorkflow(
  config: GpuImageBuildConfig,
  token: string,
  inputs: Record<string, string>,
): Promise<void> {
  const [owner, repo] = config.repository.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid GITHUB_BUILD_REPO: ${config.repository}`);
  }

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${config.workflowId}/dispatches`,
    {
      method: "POST",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "ultralight-gpu-builder",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(
        {
          ref: config.ref,
          inputs,
        } satisfies GithubWorkflowDispatchPayload,
      ),
    },
  );

  if (!response.ok) {
    throw new Error(
      `GitHub workflow dispatch failed (${response.status}): ${await response
        .text()}`,
    );
  }
}

async function resolveGithubActionsToken(): Promise<string> {
  const staticToken = getEnv("GITHUB_ACTIONS_TOKEN") ||
    getEnv("GITHUB_BUILD_TOKEN");
  if (staticToken) return staticToken;

  const appId = getEnv("GITHUB_APP_ID");
  const privateKey = getEnv("GITHUB_APP_PRIVATE_KEY");
  const installationId = getEnv("GITHUB_INSTALLATION_ID");
  if (!appId || !privateKey || !installationId) {
    throw new Error(
      "GitHub Actions token missing. Configure GITHUB_ACTIONS_TOKEN or GitHub App credentials.",
    );
  }

  const jwt = await createGithubAppJwt(appId, privateKey);
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${jwt}`,
        "User-Agent": "ultralight-gpu-builder",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `GitHub installation token request failed (${response.status}): ${await response
        .text()}`,
    );
  }

  const body = await response.json() as { token?: string };
  if (!body.token) {
    throw new Error(
      "GitHub installation token response did not include a token",
    );
  }
  return body.token;
}

async function createGithubAppJwt(
  appId: string,
  privateKeyPem: string,
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: appId,
  });
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    textEncoder.encode(signingInput),
  );
  return `${signingInput}.${base64UrlBytes(new Uint8Array(signature))}`;
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const normalized = pem.replaceAll("\\n", "\n").replace(/\r/g, "");
  const base64 = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function base64UrlJson(value: Record<string, unknown>): string {
  return base64UrlBytes(textEncoder.encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/g,
    "",
  );
}

function getBuildContextKey(
  appId: string,
  version: string,
  token: string,
): string {
  return `gpu-build-contexts/${appId}/${version}/${token}/context.tar`;
}

function getBuildContextMetadataKey(
  appId: string,
  version: string,
  token: string,
): string {
  return `gpu-build-contexts/${appId}/${version}/${token}/metadata.json`;
}

function getPlatformBaseUrl(): string {
  const baseUrl = getEnv("PLATFORM_URL") || getEnv("APP_URL") ||
    getEnv("BASE_URL");
  if (!baseUrl) {
    throw new Error(
      "PLATFORM_URL, APP_URL, or BASE_URL is required for GPU image builds",
    );
  }
  return baseUrl.replace(/\/+$/, "");
}

function normalizeImageNamespace(namespace: string): string {
  return namespace.replace(/\/+$/, "").toLowerCase();
}

function normalizeBuildPath(name: string): string {
  const normalized = name.replace(/\\/g, "/");
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new Error(`GPU build file path cannot contain '..': ${name}`);
  }
  return parts.join("/");
}

function isBuildContextToken(token: string): boolean {
  return /^[a-f0-9]{64}$/.test(token);
}

function parsePositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function timingSafeEqual(expected: string, provided: string): boolean {
  const expectedBytes = textEncoder.encode(expected);
  const providedBytes = textEncoder.encode(provided);
  let diff = expectedBytes.length ^ providedBytes.length;
  const maxLength = Math.max(expectedBytes.length, providedBytes.length);
  for (let i = 0; i < maxLength; i++) {
    diff |= (expectedBytes[i] || 0) ^ (providedBytes[i] || 0);
  }
  return diff === 0;
}
