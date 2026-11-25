-- New accounts stay unlocked until the browser closes (the keys live only in
-- the browser's memory). Existing accounts keep the auto-lock they chose.
ALTER TABLE "users" ALTER COLUMN "autoLockMinutes" SET DEFAULT 43200;
