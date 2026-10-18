// TEST_MIGRATIONS is a test-only binding added in vitest.config.ts. The
// `env` export of `cloudflare:workers` (declared by the wrangler-generated
// worker-configuration.d.ts) is typed as Cloudflare.Env, so augment that
// interface to make the binding visible in tests.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: { name: string; queries: string[] }[];
  }
}
