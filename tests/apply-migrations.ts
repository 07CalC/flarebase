import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { TEST_SECRET } from "./test-env";

// Setup files run outside the per-test-file storage isolation, so the schema
// is present in the storage every test file forks from. applyD1Migrations is
// idempotent (it records applied migrations in the `migrations` table, the
// same table wrangler.jsonc configures), which also makes it safe if this
// file is evaluated more than once.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS, "migrations");

// The suite signs tokens with TEST_SECRET and the worker verifies them with
// env.JWT_SECRET; fail fast (once, here) if the runtime secret drifted away
// from the pinned test binding.
if (env.JWT_SECRET !== TEST_SECRET) {
  throw new Error(
    "test environment JWT_SECRET does not match TEST_SECRET from tests/test-env.ts",
  );
}
