-- A subscription-backed Compute lease starts with its capacity held, not
-- released.  The original capacity-conservation constraint incorrectly
-- required the eventual release equation on the initial `reserved` row,
-- making every subscription lease fail before a container could start.
--
-- Keep the reservation shape explicit:
--   reserved            actual = 0, released = 0
--   settlement_pending  released = max(reserved - actual, 0)
--   settled/released    released = max(reserved - actual, 0)
-- Wallet reservations retain their existing funded-hold invariant.

ALTER TABLE public.compute_run_budget_reservations
  DROP CONSTRAINT compute_budget_amount_check,
  ADD CONSTRAINT compute_budget_amount_check CHECK (
    reserved_light >= 0
    AND actual_light >= 0
    AND released_light >= 0
    AND released_light <= reserved_light
    AND (
      (
        billing_mode = 'wallet'
        AND actual_light <= reserved_light
      )
      OR (
        billing_mode = 'subscription_capacity'
        AND (
          (
            status = 'reserved'
            AND actual_light = 0
            AND released_light = 0
          )
          OR (
            status <> 'reserved'
            AND released_light = GREATEST(reserved_light - actual_light, 0)
          )
        )
      )
    )
  );
