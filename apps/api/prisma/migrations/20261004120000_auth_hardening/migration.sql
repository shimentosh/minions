-- A TOTP code is accepted once: later codes must be from a newer time step.
ALTER TABLE "users" ADD COLUMN "lastTotpStep" INTEGER;
