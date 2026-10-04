import { execSync } from "node:child_process";
import "dotenv/config";
import { Client } from "pg";

/**
 * Creates the dedicated test database if needed and applies migrations with
 * `prisma migrate deploy`. Never touches DATABASE_URL.
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  const dbName = new URL(url).pathname.slice(1);
  if (!/_test$/.test(dbName))
    throw new Error("TEST_DATABASE_URL must point at a database whose name ends in _test");

  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
  if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${dbName}"`);
  await client.end();

  execSync("npx prisma migrate deploy", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: url },
  });
}
