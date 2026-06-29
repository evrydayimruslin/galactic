-- Phase 2 trust signal: per-(caller, app, version) open-code verification reads.
--
-- gx.verify records one row per (user, app, version): did the caller verify this
-- Agent's integrity (executed-bundle match + published-signature validity) and,
-- when the code is open, confirm the source hashes? Phase 4 ranking reads this
-- as the "open_code_read" qualifier — an Agent whose code is downloaded, hashed,
-- and verified by independent callers before they call it ranks higher than one
-- that is merely downloadable. Latest verdict per (app, user, version) is kept
-- (upsert), so the table is bounded and "distinct verifiers" is a clean count.
CREATE TABLE IF NOT EXISTS public.app_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL,
  user_id uuid NOT NULL,
  version text NOT NULL DEFAULT '',
  -- Did each downloaded source file match the signed artifact_hashes? null when
  -- the code is not open (integrity-only verification, no file match performed).
  files_match boolean,
  -- Raw executed-bundle verify status (ok / hash_mismatch / bad_signature /
  -- version_mismatch / no_attestation / error) from the Phase 0 attestation.
  executed_bundle_status text,
  -- Did the platform-held HMAC over the published trust metadata still verify?
  signature_valid boolean,
  -- Was the source downloadable at verify time?
  open_code boolean NOT NULL DEFAULT false,
  verified_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, user_id, version)
);

-- Phase 4 lookups: "how many distinct users verified this app recently" and
-- "did THIS caller verify before calling".
CREATE INDEX IF NOT EXISTS idx_app_verifications_app
  ON public.app_verifications (app_id, verified_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_verifications_app_user
  ON public.app_verifications (app_id, user_id, verified_at DESC);

ALTER TABLE public.app_verifications OWNER TO postgres;
GRANT SELECT, INSERT, UPDATE ON TABLE public.app_verifications TO service_role;
