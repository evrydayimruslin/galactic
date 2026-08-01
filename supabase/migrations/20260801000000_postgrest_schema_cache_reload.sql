-- The membership deployment migration added builder-handoff lineage columns
-- after PostgREST had already cached the table shape. Ask every hosted
-- PostgREST instance to reload its schema after this transaction commits.
-- The API keeps a fail-closed legacy-select retry for rollout skew, but the
-- canonical projection remains the complete current schema.

NOTIFY pgrst, 'reload schema';
