-- Forward repair for environments that applied 20260715120000 before the
-- PL/pgSQL output-column ambiguity was caught by the full local lint gate.
--
-- Fresh databases already receive the qualified reference from the amended
-- foundation migration, so this block is deliberately a no-op there. Existing
-- staging databases retain the exact deployed function body except for the
-- unsafe unqualified billing_plans.code reference.

DO $$
DECLARE
  v_signature regprocedure :=
    'public.reserve_account_capacity(uuid,text,double precision,timestamp with time zone,jsonb,timestamp with time zone)'::regprocedure;
  v_definition text;
  v_unsafe text := 'FROM public.billing_plans WHERE code = v_ent.plan_code';
  v_safe text :=
    'FROM public.billing_plans AS plans WHERE plans.code = v_ent.plan_code';
BEGIN
  SELECT pg_get_functiondef(v_signature) INTO v_definition;

  IF position(v_unsafe IN v_definition) > 0 THEN
    v_definition := replace(v_definition, v_unsafe, v_safe);
    EXECUTE v_definition;
  END IF;
END;
$$;
