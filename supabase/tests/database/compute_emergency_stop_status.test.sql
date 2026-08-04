BEGIN;

SELECT plan(11);

SELECT ok(
  to_regprocedure('public.get_compute_emergency_stop_status()') IS NOT NULL,
  'emergency-stop status projection exists'
);
SELECT ok(
  (
    SELECT procedure.prosecdef
    FROM pg_proc AS procedure
    WHERE procedure.oid =
      to_regprocedure('public.get_compute_emergency_stop_status()')
  ),
  'emergency-stop status projection is security definer'
);
SELECT is(
  (
    SELECT procedure.provolatile
    FROM pg_proc AS procedure
    WHERE procedure.oid =
      to_regprocedure('public.get_compute_emergency_stop_status()')
  ),
  's'::"char",
  'emergency-stop status projection is stable'
);
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.get_compute_emergency_stop_status()',
    'EXECUTE'
  ),
  'service role may inspect the emergency-stop latch'
);
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.get_compute_emergency_stop_status()',
    'EXECUTE'
  ),
  'anonymous callers cannot inspect the emergency-stop latch'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.get_compute_emergency_stop_status()',
    'EXECUTE'
  ),
  'authenticated callers cannot inspect the emergency-stop latch'
);
SELECT is(
  public.get_compute_emergency_stop_status(),
  '{
    "schema_version": 1,
    "latch_state": "clear",
    "operation_id": null,
    "cutoff_at": null,
    "target_count": null,
    "terminalized_count": null,
    "pending_target_count": null,
    "created_at": null,
    "updated_at": null,
    "completed_at": null
  }'::jsonb,
  'no unreleased operation reports a clear latch'
);

INSERT INTO public.compute_emergency_stop_operations (
  id,
  request_hash,
  operator_reference,
  reason,
  status,
  cutoff_at
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  repeat('a', 64),
  'test:operator',
  'status projection contract test',
  'active',
  now()
);

SELECT ok(
  (public.get_compute_emergency_stop_status()->>'latch_state') = 'active'
  AND (public.get_compute_emergency_stop_status()->>'operation_id')::uuid =
    '11111111-1111-4111-8111-111111111111'::uuid
  AND (public.get_compute_emergency_stop_status()->>'target_count')::integer = 0
  AND (public.get_compute_emergency_stop_status()->>'terminalized_count')::integer = 0
  AND (public.get_compute_emergency_stop_status()->>'pending_target_count')::integer = 0
  AND public.get_compute_emergency_stop_status()->'cutoff_at' IS NOT NULL
  AND public.get_compute_emergency_stop_status()->'created_at' IS NOT NULL
  AND public.get_compute_emergency_stop_status()->'updated_at' IS NOT NULL
  AND public.get_compute_emergency_stop_status()->'completed_at' = 'null'::jsonb,
  'an active operation reports only its identity and aggregate progress'
);
SELECT is(
  jsonb_object_length(public.get_compute_emergency_stop_status()),
  10,
  'the projection exposes only its reviewed status fields'
);

UPDATE public.compute_emergency_stop_operations
SET status = 'completed', completed_at = now(), updated_at = now()
WHERE id = '11111111-1111-4111-8111-111111111111';

SELECT ok(
  (public.get_compute_emergency_stop_status()->>'latch_state') = 'completed'
  AND (public.get_compute_emergency_stop_status()->>'operation_id')::uuid =
    '11111111-1111-4111-8111-111111111111'::uuid
  AND (public.get_compute_emergency_stop_status()->>'target_count')::integer = 0
  AND (public.get_compute_emergency_stop_status()->>'terminalized_count')::integer = 0
  AND (public.get_compute_emergency_stop_status()->>'pending_target_count')::integer = 0
  AND public.get_compute_emergency_stop_status()->'completed_at' IS NOT NULL,
  'a completed unreleased operation remains identifiable and latched'
);

UPDATE public.compute_emergency_stop_operations
SET status = 'released',
    release_request_hash = repeat('b', 64),
    release_operator_reference = 'test:operator',
    release_reason = 'status projection contract test complete',
    released_at = now(),
    updated_at = now()
WHERE id = '11111111-1111-4111-8111-111111111111';

SELECT is(
  public.get_compute_emergency_stop_status(),
  '{
    "schema_version": 1,
    "latch_state": "clear",
    "operation_id": null,
    "cutoff_at": null,
    "target_count": null,
    "terminalized_count": null,
    "pending_target_count": null,
    "created_at": null,
    "updated_at": null,
    "completed_at": null
  }'::jsonb,
  'a released operation clears the latch'
);

SELECT * FROM finish();

ROLLBACK;
