// GPU Compute Runtime — Pricing Display Service
// Generates human-readable pricing strings and marketplace display objects
// from a GPU app's config + benchmark stats. Pure utility — no API calls.

import type { GpuType, GpuPricingConfig, BenchmarkStats } from './types.ts';
import { computeGpuCostLight, isValidGpuType } from './types.ts';
import type { App } from '../../../shared/types/index.ts';
import { formatLight } from '../../../shared/types/index.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Marketplace-friendly pricing display for a GPU function. */
export interface GpuPricingDisplay {
  /** Pricing model label, e.g. "Per Call", "Per Image", "Per Duration" */
  mode_label: string;
  /** Developer fee display, e.g. "✦80 per call", "✦40 per image" */
  developer_fee: string;
  /** Estimated compute cost, e.g. "~✦2 compute (A100, ~5s)" */
  estimated_compute: string;
  /** Total estimate, e.g. "~✦82 per call" */
  total_estimate: string;
  /** GPU type, e.g. "A100-80GB-SXM" */
  gpu_type: string;
  /** Mean duration from benchmark, e.g. "5.2s" */
  avg_duration: string | null;
  /** Unit label for per_unit mode, e.g. "image" */
  unit_label: string | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate marketplace pricing display for a GPU app.
 *
 * Reads gpu_pricing_config, gpu_benchmark, and gpu_type from the app record
 * to produce human-readable pricing strings for marketplace display.
 */
export function formatGpuPricing(app: App): GpuPricingDisplay {
  const gpuTypeRaw = app.gpu_type ?? '';
  const gpuType = gpuTypeRaw || 'unknown';
  const pricingConfig = app.gpu_pricing_config as GpuPricingConfig | null;
  const benchmark = app.gpu_benchmark as BenchmarkStats | null;

  // Compute baseline: estimated compute cost from benchmark mean
  const meanMs = benchmark?.mean_ms ?? null;
  const avgDuration = meanMs !== null ? `${(meanMs / 1000).toFixed(1)}s` : null;

  let estimatedComputeLight = 0;
  if (meanMs !== null && isValidGpuType(gpuTypeRaw)) {
    estimatedComputeLight = computeGpuCostLight(gpuTypeRaw as GpuType, meanMs);
  }

  const computeDisplay = formatGpuCostEstimate(gpuType, meanMs, estimatedComputeLight);

  // No pricing config → free (compute only)
  if (!pricingConfig) {
    return {
      mode_label: 'Compute Only',
      developer_fee: 'No developer fee',
      estimated_compute: computeDisplay,
      total_estimate: estimatedComputeLight > 0
        ? `~${formatLight(estimatedComputeLight)} per call`
        : 'Variable (compute only)',
      gpu_type: gpuType,
      avg_duration: avgDuration,
      unit_label: null,
    };
  }

  // Format based on pricing mode
  switch (pricingConfig.mode) {
    case 'per_call': {
      const flatFee = pricingConfig.flat_fee_light ?? 0;
      const total = estimatedComputeLight + flatFee;
      return {
        mode_label: 'Per Call',
        developer_fee: `${formatLight(flatFee)} per call`,
        estimated_compute: computeDisplay,
        total_estimate: `~${formatLight(total)} per call`,
        gpu_type: gpuType,
        avg_duration: avgDuration,
        unit_label: null,
      };
    }

    case 'per_unit': {
      const unitPrice = pricingConfig.unit_price_light ?? 0;
      const label = pricingConfig.unit_label ?? 'unit';
      return {
        mode_label: `Per ${capitalize(label)}`,
        developer_fee: `${formatLight(unitPrice)} per ${label}`,
        estimated_compute: computeDisplay,
        total_estimate: `compute + ${formatLight(unitPrice)} × ${label}s`,
        gpu_type: gpuType,
        avg_duration: avgDuration,
        unit_label: label,
      };
    }

    case 'per_duration': {
      const markup = pricingConfig.duration_markup_light ?? 0;
      const perSecond = pricingConfig.duration_rate_light_per_second ?? 0;
      const estimatedSeconds = meanMs !== null ? Math.ceil(meanMs / 1000) : null;
      const developerEstimate = (estimatedSeconds ?? 0) * perSecond + markup;
      const totalEstimate = estimatedComputeLight + developerEstimate;
      const developerParts = [];
      if (perSecond > 0) developerParts.push(`${formatLight(perSecond)} per billed second`);
      if (markup > 0) developerParts.push(`${formatLight(markup)} per call`);
      return {
        mode_label: 'Per Duration',
        developer_fee: developerParts.length > 0
          ? developerParts.join(' + ')
          : 'No developer fee',
        estimated_compute: computeDisplay,
        total_estimate: totalEstimate > 0
          ? `~${formatLight(totalEstimate)} per call (est.)`
          : 'Variable (duration-based)',
        gpu_type: gpuType,
        avg_duration: avgDuration,
        unit_label: null,
      };
    }

    default:
      return {
        mode_label: 'Custom',
        developer_fee: 'Custom pricing',
        estimated_compute: computeDisplay,
        total_estimate: 'Contact developer',
        gpu_type: gpuType,
        avg_duration: avgDuration,
        unit_label: null,
      };
  }
}

/**
 * Format a GPU cost estimate string.
 * Returns e.g. "~✦2 compute (A100, ~5.0s)" or "Variable compute" if no benchmark.
 */
export function formatGpuCostEstimate(
  gpuType: string,
  meanMs: number | null,
  computeLight?: number,
): string {
  if (meanMs === null) {
    return `Variable compute (${gpuType})`;
  }

  const light = computeLight ?? 0;
  const durationDisplay = `${(meanMs / 1000).toFixed(1)}s`;
  return `~${formatLight(light)} compute (${gpuType}, ~${durationDisplay})`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capitalize first letter. */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
