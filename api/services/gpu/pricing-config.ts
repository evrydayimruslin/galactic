import type { GpuPricingConfig } from './types.ts';

const MAX_GPU_DEVELOPER_FEE_LIGHT = 10_000;

export interface GpuPricingValidationResult {
  valid: boolean;
  config: GpuPricingConfig | null;
  error?: string;
}

export function validateGpuPricingConfig(input: unknown): GpuPricingValidationResult {
  if (input === null || input === undefined) {
    return { valid: true, config: null };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, config: null, error: 'gpu_pricing_config must be an object or null' };
  }

  const raw = input as Record<string, unknown>;
  const mode = raw.mode;
  if (mode !== 'per_call' && mode !== 'per_unit' && mode !== 'per_duration') {
    return {
      valid: false,
      config: null,
      error: 'gpu_pricing_config.mode must be "per_call", "per_unit", or "per_duration"',
    };
  }

  const config: GpuPricingConfig = { mode };

  if (mode === 'per_call') {
    const flatFee = validateOptionalLightAmount(raw.flat_fee_light, 'flat_fee_light');
    if (flatFee.error) return { valid: false, config: null, error: flatFee.error };
    config.flat_fee_light = flatFee.value ?? 0;
  }

  if (mode === 'per_unit') {
    const unitPrice = validateOptionalLightAmount(raw.unit_price_light, 'unit_price_light');
    if (unitPrice.error) return { valid: false, config: null, error: unitPrice.error };
    config.unit_price_light = unitPrice.value ?? 0;

    if (raw.unit_count_from !== undefined) {
      if (typeof raw.unit_count_from !== 'string' || raw.unit_count_from.trim().length === 0) {
        return { valid: false, config: null, error: 'unit_count_from must be a non-empty string' };
      }
      config.unit_count_from = raw.unit_count_from.trim();
    }

    if (raw.unit_label !== undefined) {
      if (typeof raw.unit_label !== 'string' || raw.unit_label.trim().length === 0 || raw.unit_label.length > 40) {
        return { valid: false, config: null, error: 'unit_label must be a 1-40 character string' };
      }
      config.unit_label = raw.unit_label.trim();
    }
  }

  if (mode === 'per_duration') {
    const markup = validateOptionalLightAmount(raw.duration_markup_light, 'duration_markup_light');
    if (markup.error) return { valid: false, config: null, error: markup.error };
    config.duration_markup_light = markup.value ?? 0;

    const perSecond = validateOptionalLightAmount(
      raw.duration_rate_light_per_second,
      'duration_rate_light_per_second',
    );
    if (perSecond.error) return { valid: false, config: null, error: perSecond.error };
    config.duration_rate_light_per_second = perSecond.value ?? 0;
  }

  return { valid: true, config };
}

function validateOptionalLightAmount(
  value: unknown,
  fieldName: string,
): { value?: number; error?: string } {
  if (value === undefined || value === null) return {};
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_GPU_DEVELOPER_FEE_LIGHT
  ) {
    return { error: `${fieldName} must be a number from 0 to ${MAX_GPU_DEVELOPER_FEE_LIGHT} Light` };
  }
  return { value };
}
