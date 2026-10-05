import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Not env("DATABASE_URL"): that throws when unset, which breaks `prisma generate`
  // (run on postinstall) on a fresh clone before .env exists. Generate needs no URL.
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
