// Single source of truth for the JWT secret used in tests: imported both by
// vitest.config.ts (Node) and by tests/*.ts (workerd), so it must stay free of
// runtime-specific imports.
export const TEST_SECRET = "test-secret-for-collection-tests";
