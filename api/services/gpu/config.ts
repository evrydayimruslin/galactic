// GPU Compute Runtime — Config Parser
// Parses and validates ultralight.gpu.yaml from uploaded files.
// Pure utility — no API calls, no side effects.

import { parse as parseYaml } from 'yaml';
import type { GpuBaseProfile, GpuConfig, GpuType } from './types.ts';
import { GPU_BASE_PROFILES, isValidGpuType } from './types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result from parsing ultralight.gpu.yaml. */
export interface GpuConfigValidation {
  valid: boolean;
  config?: GpuConfig;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Python versions supported for GPU containers. */
const ALLOWED_PYTHON_VERSIONS = ['3.10', '3.11'];

/** Default Python version when not specified. */
const DEFAULT_PYTHON_VERSION = '3.11';

/** Default platform base image profile. */
const DEFAULT_BASE_PROFILE: GpuBaseProfile = 'python-cuda';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect whether uploaded files contain a GPU function.
 * Returns the raw YAML content if ultralight.gpu.yaml is found, null otherwise.
 *
 * Handles folder-prefixed names (e.g. "myapp/ultralight.gpu.yaml").
 * Mirrors the manifest detection pattern in upload.ts.
 */
export function detectGpuConfig(
  files: Array<{ name: string; content: string }>,
): string | null {
  const gpuConfigFile = files.find((f) => {
    const fileName = f.name.split('/').pop() || f.name;
    return fileName === 'ultralight.gpu.yaml';
  });
  return gpuConfigFile?.content ?? null;
}

// ---------------------------------------------------------------------------
// Parsing & Validation
// ---------------------------------------------------------------------------

/**
 * Parse and validate an ultralight.gpu.yaml file.
 *
 * Expected format:
 * ```yaml
 * runtime: gpu
 * gpu_type: A100-80GB-SXM
 * base: torch-cuda       # optional, defaults to python-cuda
 * python: "3.11"          # optional, defaults to 3.11
 * max_duration_ms: 30000  # optional
 * ```
 */
export function parseGpuConfig(yamlContent: string): GpuConfigValidation {
  const errors: string[] = [];

  // Step 1: Parse YAML
  let parsed: Record<string, unknown>;
  try {
    const raw = parseYaml(yamlContent);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { valid: false, errors: ['ultralight.gpu.yaml must be a YAML object'] };
    }
    parsed = raw as Record<string, unknown>;
  } catch (err) {
    return {
      valid: false,
      errors: [`Failed to parse YAML: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  // Step 2: Validate runtime
  if (parsed.runtime !== 'gpu') {
    errors.push(`"runtime" must be "gpu", got "${String(parsed.runtime ?? 'undefined')}"`);
  }

  // Step 3: Validate gpu_type
  const gpuTypeRaw = String(parsed.gpu_type ?? '');
  if (!gpuTypeRaw) {
    errors.push('"gpu_type" is required');
  } else if (!isValidGpuType(gpuTypeRaw)) {
    errors.push(
      `"gpu_type" must be one of: A40, L40, L40S, A100-80GB-PCIe, A100-80GB-SXM, ` +
      `H100-PCIe, H100-SXM, H100-NVL, H200, B200. Got "${gpuTypeRaw}"`,
    );
  }

  // Step 4: Validate base profile (optional)
  let base: GpuBaseProfile = DEFAULT_BASE_PROFILE;
  if (parsed.base !== undefined) {
    const rawBase = String(parsed.base);
    if (!(GPU_BASE_PROFILES as string[]).includes(rawBase)) {
      errors.push(
        `"base" must be one of: ${GPU_BASE_PROFILES.join(', ')}. Got "${rawBase}"`,
      );
    } else {
      base = rawBase as GpuBaseProfile;
    }
  }

  // Step 5: Validate python version (optional)
  let python = DEFAULT_PYTHON_VERSION;
  if (parsed.python !== undefined) {
    const pyVersion = String(parsed.python);
    if (!ALLOWED_PYTHON_VERSIONS.includes(pyVersion)) {
      errors.push(
        `"python" must be one of: ${ALLOWED_PYTHON_VERSIONS.join(', ')}. Got "${pyVersion}"`,
      );
    } else {
      python = pyVersion;
    }
  }

  // Step 6: Validate max_duration_ms (optional)
  let maxDurationMs: number | undefined;
  if (parsed.max_duration_ms !== undefined) {
    const raw = Number(parsed.max_duration_ms);
    if (!Number.isInteger(raw) || raw <= 0) {
      errors.push(`"max_duration_ms" must be a positive integer, got "${String(parsed.max_duration_ms)}"`);
    } else {
      maxDurationMs = raw;
    }
  }

  // Return result
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const config: GpuConfig = {
    runtime: 'gpu',
    gpu_type: gpuTypeRaw as GpuType,
    base,
    python,
    max_duration_ms: maxDurationMs,
  };

  return { valid: true, config, errors: [] };
}
