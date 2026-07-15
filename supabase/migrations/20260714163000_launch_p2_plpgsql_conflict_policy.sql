-- Forward repair for P0/P1 functions that return TABLE columns whose names
-- intentionally overlap queried columns. Both functions mean table columns
-- at those ambiguous SQL sites. Pin that policy in each stored function
-- without rewriting the already-applied migration history.

DO $migration$
DECLARE
  v_signature regprocedure;
  v_definition text;
  v_fixed text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.reserve_routine_run_budget(uuid,uuid,uuid,text,text,double precision,timestamp with time zone)'::regprocedure,
    'public.claim_agent_home_action(uuid,uuid,bigint,text,text,jsonb)'::regprocedure
  ]
  LOOP
    SELECT pg_get_functiondef(v_signature) INTO v_definition;
    v_fixed := replace(
      v_definition,
      E'AS $function$\n',
      E'AS $function$\n#variable_conflict use_column\n'
    );

    IF v_fixed = v_definition THEN
      RAISE EXCEPTION
        'Unable to pin PL/pgSQL conflict policy for %', v_signature;
    END IF;

    EXECUTE v_fixed;
  END LOOP;
END;
$migration$;
