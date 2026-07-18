-- Capacity-only Cloudflare marginal rate card (100 canonical Light / USD).
--
-- The legacy cloud-unit columns remain untouched because they still price the
-- historical wallet/marketplace ledger. Subscription capacity records raw
-- resource facts and applies these direct marginal rates without per-call
-- rounding. `version` is bumped by the table's existing UPDATE trigger, while
-- capacity_rate_card_version identifies this operation-class taxonomy.

ALTER TABLE public.platform_billing_config
  ADD COLUMN IF NOT EXISTS capacity_rate_card_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS capacity_d1_read_light_per_million_rows
    double precision NOT NULL DEFAULT 0.1,
  ADD COLUMN IF NOT EXISTS capacity_d1_write_light_per_million_rows
    double precision NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS capacity_kv_read_light_per_million_operations
    double precision NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS capacity_kv_write_light_per_million_operations
    double precision NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS capacity_kv_delete_light_per_million_operations
    double precision NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS capacity_kv_list_light_per_million_operations
    double precision NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS capacity_r2_class_a_light_per_million_operations
    double precision NOT NULL DEFAULT 450,
  ADD COLUMN IF NOT EXISTS capacity_r2_class_b_light_per_million_operations
    double precision NOT NULL DEFAULT 36,
  ADD COLUMN IF NOT EXISTS capacity_r2_delete_light_per_million_operations
    double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS capacity_queue_light_per_million_operations
    double precision NOT NULL DEFAULT 40;

ALTER TABLE public.platform_billing_config
  DROP CONSTRAINT IF EXISTS platform_billing_config_capacity_rate_card_valid;
ALTER TABLE public.platform_billing_config
  ADD CONSTRAINT platform_billing_config_capacity_rate_card_valid CHECK (
    capacity_rate_card_version > 0
    AND capacity_d1_read_light_per_million_rows >= 0
    AND capacity_d1_read_light_per_million_rows < 'Infinity'::double precision
    AND capacity_d1_write_light_per_million_rows >= 0
    AND capacity_d1_write_light_per_million_rows < 'Infinity'::double precision
    AND capacity_kv_read_light_per_million_operations >= 0
    AND capacity_kv_read_light_per_million_operations < 'Infinity'::double precision
    AND capacity_kv_write_light_per_million_operations >= 0
    AND capacity_kv_write_light_per_million_operations < 'Infinity'::double precision
    AND capacity_kv_delete_light_per_million_operations >= 0
    AND capacity_kv_delete_light_per_million_operations < 'Infinity'::double precision
    AND capacity_kv_list_light_per_million_operations >= 0
    AND capacity_kv_list_light_per_million_operations < 'Infinity'::double precision
    AND capacity_r2_class_a_light_per_million_operations >= 0
    AND capacity_r2_class_a_light_per_million_operations < 'Infinity'::double precision
    AND capacity_r2_class_b_light_per_million_operations >= 0
    AND capacity_r2_class_b_light_per_million_operations < 'Infinity'::double precision
    AND capacity_r2_delete_light_per_million_operations >= 0
    AND capacity_r2_delete_light_per_million_operations < 'Infinity'::double precision
    AND capacity_queue_light_per_million_operations >= 0
    AND capacity_queue_light_per_million_operations < 'Infinity'::double precision
  );

UPDATE public.platform_billing_config
SET
  capacity_rate_card_version = 1,
  capacity_d1_read_light_per_million_rows = 0.1,
  capacity_d1_write_light_per_million_rows = 100,
  capacity_kv_read_light_per_million_operations = 50,
  capacity_kv_write_light_per_million_operations = 500,
  capacity_kv_delete_light_per_million_operations = 500,
  capacity_kv_list_light_per_million_operations = 500,
  capacity_r2_class_a_light_per_million_operations = 450,
  capacity_r2_class_b_light_per_million_operations = 36,
  capacity_r2_delete_light_per_million_operations = 0,
  capacity_queue_light_per_million_operations = 40
WHERE id = 'singleton';

COMMENT ON COLUMN public.platform_billing_config.capacity_rate_card_version IS
  'Capacity-only Cloudflare marginal operation taxonomy; independent of legacy wallet cloud units.';
COMMENT ON COLUMN public.platform_billing_config.capacity_queue_light_per_million_operations IS
  'Customer-attributable EXEC and receipt-backed EVENT queue operations. EVENT consumer cost is allocated once per pass, never per subscriber. Telemetry, settlement-recovery, and EVENT cycles with no settlement receipt remain platform reconciliation overhead.';
