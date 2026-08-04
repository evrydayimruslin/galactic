-- WO-F4: the device authorization grant (gh/flyctl shape).
--
-- A CLI mints a short-lived pairing: the human confirms the user code on
-- /device inside their EXISTING web session (magic link or provider OAuth
-- — nothing new), and the CLI's poll exchanges the device code for a
-- standard-scope gx_ API key through the existing token service. New
-- issuance path, zero new token types. Codes are single-use, short-lived,
-- and the device code is stored only as a hash.

CREATE TABLE public.device_authorizations (
  id uuid PRIMARY KEY,
  user_code text NOT NULL UNIQUE
    CHECK (user_code ~ '^[A-Z2-9]{4}-[A-Z2-9]{4}$'),
  device_code_hash text NOT NULL UNIQUE
    CHECK (char_length(device_code_hash) = 64),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'consumed', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Ten minutes to walk to a browser; pinned like the funnel windows.
  expires_at timestamptz NOT NULL,
  approved_by uuid REFERENCES public.users(id) ON DELETE CASCADE,
  approved_at timestamptz,
  consumed_at timestamptz,
  CONSTRAINT device_authorizations_window_check
    CHECK (expires_at = created_at + interval '10 minutes'),
  CONSTRAINT device_authorizations_approval_pair_check
    CHECK ((approved_at IS NULL) = (approved_by IS NULL))
);

CREATE INDEX device_authorizations_reap_idx
  ON public.device_authorizations (expires_at)
  WHERE status IN ('pending', 'approved');

ALTER TABLE public.device_authorizations ENABLE ROW LEVEL SECURITY;
-- Service-role only; all access goes through the device routes.
