-- PR27: tax-location foundation for Light receipts.
-- This does not enable tax collection. It records the buyer tax address version
-- available at receipt creation time so future tax calculations have an audit
-- substrate without duplicating full address PII on every ledger entry.

CREATE TABLE IF NOT EXISTS public.user_billing_addresses (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  version integer NOT NULL,
  is_current boolean NOT NULL DEFAULT true,
  name text,
  line1 text NOT NULL,
  line2 text,
  city text NOT NULL,
  state text,
  postal_code text NOT NULL,
  country text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  stripe_customer_id text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_billing_addresses_country_check CHECK (country ~ '^[A-Z]{2}$'),
  CONSTRAINT user_billing_addresses_version_check CHECK (version > 0),
  CONSTRAINT user_billing_addresses_source_check CHECK (
    source IN ('manual', 'wallet_funding', 'wire_funding', 'stripe_customer')
  ),
  CONSTRAINT user_billing_addresses_required_text_check CHECK (
    length(btrim(line1)) > 0
    AND length(btrim(city)) > 0
    AND length(btrim(postal_code)) > 0
    AND length(btrim(country)) = 2
  ),
  CONSTRAINT user_billing_addresses_region_check CHECK (
    country NOT IN ('US', 'CA') OR length(btrim(COALESCE(state, ''))) > 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS user_billing_addresses_user_version_idx
  ON public.user_billing_addresses(user_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS user_billing_addresses_current_idx
  ON public.user_billing_addresses(user_id)
  WHERE is_current;
CREATE INDEX IF NOT EXISTS user_billing_addresses_user_created_idx
  ON public.user_billing_addresses(user_id, created_at DESC);

DROP TRIGGER IF EXISTS touch_user_billing_addresses_updated_at
  ON public.user_billing_addresses;
CREATE TRIGGER touch_user_billing_addresses_updated_at
BEFORE UPDATE ON public.user_billing_addresses
FOR EACH ROW EXECUTE FUNCTION public.touch_stripe_payment_ledgers_updated_at();

ALTER TABLE public.user_billing_addresses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_billing_addresses_own_select
  ON public.user_billing_addresses;
CREATE POLICY user_billing_addresses_own_select
  ON public.user_billing_addresses
  FOR SELECT
  USING (auth.uid() = user_id);

REVOKE ALL ON TABLE public.user_billing_addresses FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.user_billing_addresses TO authenticated;
GRANT ALL ON TABLE public.user_billing_addresses TO service_role;

CREATE OR REPLACE FUNCTION public.upsert_current_user_billing_address(
  p_user_id uuid,
  p_name text DEFAULT NULL,
  p_line1 text DEFAULT NULL,
  p_line2 text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_state text DEFAULT NULL,
  p_postal_code text DEFAULT NULL,
  p_country text DEFAULT NULL,
  p_source text DEFAULT 'manual',
  p_stripe_customer_id text DEFAULT NULL
) RETURNS public.user_billing_addresses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public, extensions'
AS $$
DECLARE
  v_current public.user_billing_addresses%ROWTYPE;
  v_next_version integer;
  v_name text := NULLIF(btrim(COALESCE(p_name, '')), '');
  v_line1 text := NULLIF(btrim(COALESCE(p_line1, '')), '');
  v_line2 text := NULLIF(btrim(COALESCE(p_line2, '')), '');
  v_city text := NULLIF(btrim(COALESCE(p_city, '')), '');
  v_state text := NULLIF(btrim(COALESCE(p_state, '')), '');
  v_postal_code text := NULLIF(btrim(COALESCE(p_postal_code, '')), '');
  v_country text := upper(NULLIF(btrim(COALESCE(p_country, '')), ''));
  v_source text := COALESCE(NULLIF(btrim(p_source), ''), 'manual');
  v_result public.user_billing_addresses%ROWTYPE;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'User ID is required';
  END IF;
  IF v_line1 IS NULL THEN
    RAISE EXCEPTION 'Billing address line1 is required';
  END IF;
  IF v_city IS NULL THEN
    RAISE EXCEPTION 'Billing address city is required';
  END IF;
  IF v_postal_code IS NULL THEN
    RAISE EXCEPTION 'Billing address postal_code is required';
  END IF;
  IF v_country IS NULL OR v_country !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION 'Billing address country must be a two-letter ISO country code';
  END IF;
  IF v_country IN ('US', 'CA') AND v_state IS NULL THEN
    RAISE EXCEPTION 'Billing address state is required for US and CA addresses';
  END IF;
  IF v_source NOT IN ('manual', 'wallet_funding', 'wire_funding', 'stripe_customer') THEN
    RAISE EXCEPTION 'Unsupported billing address source: %', v_source;
  END IF;

  SELECT *
  INTO v_current
  FROM public.user_billing_addresses
  WHERE user_id = p_user_id
    AND is_current
  ORDER BY version DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND
    AND COALESCE(v_current.name, '') = COALESCE(v_name, '')
    AND v_current.line1 = v_line1
    AND COALESCE(v_current.line2, '') = COALESCE(v_line2, '')
    AND v_current.city = v_city
    AND COALESCE(v_current.state, '') = COALESCE(v_state, '')
    AND v_current.postal_code = v_postal_code
    AND v_current.country = v_country
  THEN
    UPDATE public.user_billing_addresses
    SET
      source = v_source,
      stripe_customer_id = COALESCE(p_stripe_customer_id, stripe_customer_id)
    WHERE id = v_current.id
    RETURNING * INTO v_result;
    RETURN v_result;
  END IF;

  UPDATE public.user_billing_addresses
  SET is_current = false
  WHERE user_id = p_user_id
    AND is_current;

  SELECT COALESCE(max(version), 0) + 1
  INTO v_next_version
  FROM public.user_billing_addresses
  WHERE user_id = p_user_id;

  INSERT INTO public.user_billing_addresses (
    user_id,
    version,
    is_current,
    name,
    line1,
    line2,
    city,
    state,
    postal_code,
    country,
    source,
    stripe_customer_id
  ) VALUES (
    p_user_id,
    v_next_version,
    true,
    v_name,
    v_line1,
    v_line2,
    v_city,
    v_state,
    v_postal_code,
    v_country,
    v_source,
    p_stripe_customer_id
  )
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_current_user_billing_address(
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.upsert_current_user_billing_address(
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) TO service_role;

ALTER TABLE public.platform_billing_config
  ALTER COLUMN publish_deposit_enabled SET DEFAULT true;

UPDATE public.platform_billing_config
SET publish_deposit_enabled = true
WHERE id = 'singleton';

ALTER TABLE public.light_deposits
  ADD COLUMN IF NOT EXISTS buyer_billing_address_id uuid REFERENCES public.user_billing_addresses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS buyer_billing_address_version integer,
  ADD COLUMN IF NOT EXISTS tax_status text NOT NULL DEFAULT 'not_collecting',
  ADD COLUMN IF NOT EXISTS taxable_amount_light double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount_light double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.app_sales
  ADD COLUMN IF NOT EXISTS buyer_billing_address_id uuid REFERENCES public.user_billing_addresses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS buyer_billing_address_version integer,
  ADD COLUMN IF NOT EXISTS tax_status text NOT NULL DEFAULT 'not_collecting',
  ADD COLUMN IF NOT EXISTS taxable_amount_light double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount_light double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.mcp_call_logs
  ADD COLUMN IF NOT EXISTS buyer_billing_address_id uuid REFERENCES public.user_billing_addresses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS buyer_billing_address_version integer,
  ADD COLUMN IF NOT EXISTS tax_status text NOT NULL DEFAULT 'not_collecting',
  ADD COLUMN IF NOT EXISTS taxable_amount_light double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount_light double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.light_deposits
  DROP CONSTRAINT IF EXISTS light_deposits_tax_status_check,
  DROP CONSTRAINT IF EXISTS light_deposits_tax_amounts_check;
ALTER TABLE public.light_deposits
  ADD CONSTRAINT light_deposits_tax_status_check CHECK (
    tax_status IN (
      'not_collecting',
      'not_applicable',
      'pending',
      'calculated',
      'collected',
      'remitted',
      'refunded',
      'failed'
    )
  ),
  ADD CONSTRAINT light_deposits_tax_amounts_check CHECK (
    taxable_amount_light >= 0
    AND tax_amount_light >= 0
    AND (buyer_billing_address_version IS NULL OR buyer_billing_address_version > 0)
  );

ALTER TABLE public.app_sales
  DROP CONSTRAINT IF EXISTS app_sales_tax_status_check,
  DROP CONSTRAINT IF EXISTS app_sales_tax_amounts_check;
ALTER TABLE public.app_sales
  ADD CONSTRAINT app_sales_tax_status_check CHECK (
    tax_status IN (
      'not_collecting',
      'not_applicable',
      'pending',
      'calculated',
      'collected',
      'remitted',
      'refunded',
      'failed'
    )
  ),
  ADD CONSTRAINT app_sales_tax_amounts_check CHECK (
    taxable_amount_light >= 0
    AND tax_amount_light >= 0
    AND (buyer_billing_address_version IS NULL OR buyer_billing_address_version > 0)
  );

ALTER TABLE public.mcp_call_logs
  DROP CONSTRAINT IF EXISTS mcp_call_logs_tax_status_check,
  DROP CONSTRAINT IF EXISTS mcp_call_logs_tax_amounts_check;
ALTER TABLE public.mcp_call_logs
  ADD CONSTRAINT mcp_call_logs_tax_status_check CHECK (
    tax_status IN (
      'not_collecting',
      'not_applicable',
      'pending',
      'calculated',
      'collected',
      'remitted',
      'refunded',
      'failed'
    )
  ),
  ADD CONSTRAINT mcp_call_logs_tax_amounts_check CHECK (
    taxable_amount_light >= 0
    AND tax_amount_light >= 0
    AND (buyer_billing_address_version IS NULL OR buyer_billing_address_version > 0)
  );

CREATE INDEX IF NOT EXISTS light_deposits_billing_address_idx
  ON public.light_deposits(buyer_billing_address_id)
  WHERE buyer_billing_address_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS app_sales_billing_address_idx
  ON public.app_sales(buyer_billing_address_id)
  WHERE buyer_billing_address_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mcp_call_logs_billing_address_idx
  ON public.mcp_call_logs(buyer_billing_address_id)
  WHERE buyer_billing_address_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.snapshot_current_buyer_billing_address()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public, extensions'
AS $$
DECLARE
  v_user_id uuid;
  v_address RECORD;
BEGIN
  IF TG_TABLE_NAME = 'app_sales' THEN
    v_user_id := NEW.buyer_id;
  ELSE
    v_user_id := NEW.user_id;
  END IF;

  IF NEW.buyer_billing_address_id IS NULL AND v_user_id IS NOT NULL THEN
    SELECT id, version
    INTO v_address
    FROM public.user_billing_addresses
    WHERE user_id = v_user_id
      AND is_current
    ORDER BY version DESC
    LIMIT 1;

    IF FOUND THEN
      NEW.buyer_billing_address_id := v_address.id;
      NEW.buyer_billing_address_version := v_address.version;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS snapshot_light_deposit_billing_address
  ON public.light_deposits;
CREATE TRIGGER snapshot_light_deposit_billing_address
BEFORE INSERT ON public.light_deposits
FOR EACH ROW EXECUTE FUNCTION public.snapshot_current_buyer_billing_address();

DROP TRIGGER IF EXISTS snapshot_app_sale_billing_address
  ON public.app_sales;
CREATE TRIGGER snapshot_app_sale_billing_address
BEFORE INSERT ON public.app_sales
FOR EACH ROW EXECUTE FUNCTION public.snapshot_current_buyer_billing_address();

DROP TRIGGER IF EXISTS snapshot_mcp_call_log_billing_address
  ON public.mcp_call_logs;
CREATE TRIGGER snapshot_mcp_call_log_billing_address
BEFORE INSERT ON public.mcp_call_logs
FOR EACH ROW EXECUTE FUNCTION public.snapshot_current_buyer_billing_address();
