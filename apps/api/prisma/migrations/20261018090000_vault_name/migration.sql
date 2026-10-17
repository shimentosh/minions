-- Personal vaults can be renamed; the default reads the way the app has always shown it.
ALTER TABLE "vaults" ALTER COLUMN "name" SET DEFAULT 'Personal vault';
UPDATE "vaults" SET "name" = 'Personal vault' WHERE "userId" IS NOT NULL AND "name" = 'Personal';
