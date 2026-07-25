-- Preserve the capacity-attribution invariant across the legacy admission
-- implementation wrapped by 20260720124500_compute_capacity_conservation.sql.
--
-- The private implementation inserts the base Compute run before the public
-- wrapper applies its trusted billing mode and root Agent. capacity_agent_id
-- is already NOT NULL, so give only that legacy wallet-shaped insert the
-- conservative self-attribution required to reach the wrapper's transactional
-- update. Explicit subscription inserts with a missing root remain invalid.

CREATE OR REPLACE FUNCTION public.fill_compute_run_legacy_capacity_agent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.billing_mode = 'wallet' AND NEW.capacity_agent_id IS NULL THEN
    NEW.capacity_agent_id := NEW.agent_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fill_compute_run_legacy_capacity_agent
BEFORE INSERT ON public.compute_runs
FOR EACH ROW
EXECUTE FUNCTION public.fill_compute_run_legacy_capacity_agent();

REVOKE ALL ON FUNCTION public.fill_compute_run_legacy_capacity_agent()
  FROM PUBLIC, anon, authenticated, service_role;
