# ROADMAP

A dependency-ordered plan for completing the flarebase implementation. Companion to `ARCHITECTURE.md` — see it for the big-picture design; this document tracks **what to build, in what order, and when it's done**.

Each task has: goal, scope, files touched, acceptance criteria (what must be true to close it), and dependencies. Use the checkboxes to track progress.

---

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done

> **Testing infra:** tests run inside the real Workers runtime via `@cloudflare/vitest-plugin` (`npm test`), with local D1 bindings and the migrations applied automatically. Storage isolation is per test file, so `tests/setup.ts` resets to a seeded baseline before each test; background work registered with `c.executionCtx.waitUntil` is drained deterministically via `waitOnExecutionContext`.

---

## Phase 1 — Foundation fixes

> Small, prerequisite work. Everything in later phases assumes this is in place.

### 1.1 [x] Salted password hashing

- **Goal:** a password scheme that is actually safe to store, since root auth depends on it.
- **Scope:**
  - Replace the unsalted SHA-256 `hashString` in `src/lib/hash.ts` with `hashPassword` / `verifyPassword`
  - Use PBKDF2 via `crypto.subtle` (native in Workers; no external deps), versioned hash string format for future migration, e.g. `pbkdf2$<iterations>$<salt-b64>$<hash-b64>`
  - Sensible default iterations; verification must be constant-time-ish comparison
- **Files:** `src/lib/hash.ts`
- **Depends on:** nothing
- **Acceptance:**
  - `hashPassword` output is salted and versioned; `verifyPassword(hash, password)` returns true/false
  - unit tests for hash→verify roundtrip, wrong password, and legacy-format rejection

### 1.2 [x] Global middleware wiring + code hygiene

- **Goal:** honor the ARCHITECTURE contract that *every* request is authenticated before routes; remove dead code; carry the full sanitized user row in the auth context.
- **Scope:**
  - Mount `authMiddleware` once on the root app in `src/index.ts` (before `/api/*` routes); remove per-router mounting from `collection.route.ts` (`superUserRequired` stays on the management router)
  - Extend the auth context so every route can inspect the caller: `AuthContext` now holds `id`, `isSuperUser`, `collectionId`, `collectionName`, `sessionId`, plus `user` — the **full row** of the auth table (all fields incl. hidden columns fetched internally) with sensitive fields stripped: `password` always, plus any field flagged `hidden` (case-insensitive names). Sanitization lives in `lib/auth.ts::sanitizeAuthRecord`
  - `lib/auth.ts`: `sanitizeAuthRecord` now attaches the full sanitized row to the context
  - Route all D1 throws through `mapD1Error` in `collection.service` (reads + batch writes); `getCollectionByIdOrName` only swallows invalid-identifier errors, real DB failures surface as 500
  - Tests use the real `src/index.ts` app (no duplicated onError/mounting); `tests/auth-context.test.ts` locks the context shape
  - Removed dead export `authCreateSchema` from `lib/auth.ts`
- **Files:** `src/index.ts`, `src/config.ts`, `src/middleware/auth.ts`, `src/lib/auth.ts`, `src/lib/d1-error.ts`, `src/services/collection.service.ts`, `src/services/records.service.ts`, `src/routes/collection.route.ts`, `tests/setup.ts`, `tests/auth-context.test.ts`
- **Depends on:** nothing
- **Acceptance:** ✅ context populated for all routes (full sanitized user row, no password/hidden leakage); ✅ collection + records test suites pass unchanged

### 1.3 [x] Configuration + bindings

- **Goal:** the worker config matches the target architecture (D1 + R2 + assets + secrets) and env handling is validated.
- **Scope:**
  - `wrangler.jsonc`: added `FILE_BUCKET` R2 binding (bucket `flarebase-files`), `SESSION_TTL_SECONDS` var (default 604800); DO bindings land properly in Phase 6 when the class exists; D1 `DB` and `ASSETS` untouched; types regenerated via `npm run cf-typegen`
  - `src/lib/env.ts` (new): `requireJwtSecret` — runtime fail-fast with a clear 500 "Server misconfigured" error (Workers have no true startup hook, so validation happens at first use); `resolveSessionTtlSeconds` — parses/validates the `SESSION_TTL_SECONDS` var against the 300–2592000 bounds exported by `lib/jwt.ts`
  - `src/lib/jwt.ts`: session TTL no longer hardcoded — `generateJWT(payload, secret, { ttlSeconds?, jti? })`; `DEFAULT_SESSION_TTL_SECONDS` / `MIN` / `MAX` exported
  - `src/middleware/auth.ts`: passes through structured `AppError`s to the global error handler (misconfigured env keeps its clear message instead of a masked "Internal Server Error")
  - Docs: README configuration section (bindings table, prod setup: bucket create, migrate, secret put); `.dev.vars.example` template (gitignored `.dev.vars` stays local)
- **Files:** `wrangler.jsonc`, `worker-configuration.d.ts` (generated), `src/lib/env.ts`, `src/lib/jwt.ts`, `src/middleware/auth.ts`, `README.md`, `.dev.vars.example`
- **Depends on:** nothing
- **Acceptance:** ✅ `npm run typecheck` clean; ✅ dry-run deploy exposes DB / FILE_BUCKET / ASSETS / SESSION_TTL_SECONDS bindings; ✅ `npm run dev` boots and serves `/api/health` + assets; ✅ missing secret fails with a clear error

---

## Phase 2 — Auth & records (core product)

### 2.1 [x] Auth endpoints

- **Goal:** real authentication: superuser bootstrap, password login for any auth collection, logout, session refresh, stale-session cleanup.
- **Done:**
  - `POST /api/collections/:collectionName/auth/with-password` — generic login for every `type: "auth"` collection (including `_superusers`): verifies email+password via `verifyPassword`, creates the `_sessions` row (`jti`/`exp` from a single `generateJWT` call so token and row cannot drift, TTL from `resolveSessionTtlSeconds`), returns sanitized user + token. Response sanitization strips `password` and hidden fields (`sanitizeAuthRecord(record, fields)`)
  - Failed lookups equalize timing (`equalizeLoginTiming` dummy-hash verify in `lib/hash.ts`) so login latency does not leak valid emails
  - `readJsonBody`/`formatZodIssues` conventions applied; `requireJwtSecret` fails fast on misconfig; `getRecordByField` and `createSession`/`revokeSession` flow through `mapD1Error`
  - the legacy `POST /api/collections/_superusers/auth-with-password` handler was folded into the generic route and removed from `superusers.route.ts`
  - superuser bootstrap stays on `POST /api/collections/_superusers/records` (race-safe guarded insert, 1.x)
  - **Session refresh** (rotation): `POST /api/collections/:collectionName/auth/refresh` — requires a live token of the same collection (401 anonymous / 403 cross-collection); creates the replacement session FIRST, then revokes the old `jti`, so a failed rotation never logs the caller out; returns a freshly-fetched sanitized row (not the middleware snapshot); rotation is one-way (old token cannot refresh again)
  - **Logout**: `POST /api/auth/logout` (mounted at `/api/auth`, deliberately not collection-scoped — the token is self-describing via its `jti`); revokes via `auth.sessionId`; idempotent; 401 when unauthenticated
  - **Stale-session cleanup**: `purgeExpiredSessions` (`DELETE FROM _sessions WHERE expiresAt <= now`, best-effort, failures swallowed) runs opportunistically on login + refresh; `idx_sessions_expires` added to migrations 002 (DDL + seed metadata). Revoked-but-unexpired rows are never purged early — their tokens stay rejected until the expiry passes
  - login logic kept inline in `src/routes/auth.route.ts`; extract `src/services/auth.service.ts` later if the surface grows
  - tests at `tests/auth.test.ts`: known-user + `_superusers` login, live session-row assertions, wrong password / unknown email / revoked session / expired JWT / non-auth collection / malformed JSON / missing JWT_SECRET, hidden-field stripping, token works end-to-end through `authMiddleware`, refresh rotation + freshness + one-way semantics, logout flow, purge invariants (expired deleted; live and revoked-but-unexpired kept)
- **Depends on:** 1.1 (hashing), 1.2 (global middleware), 1.3 (config)
- **Acceptance:**
  - login with wrong email / wrong password / revoked session / expired JWT → 401-400 family with correct codes ✅
  - bootstrap: works when zero superusers, 403 afterward ✅ (tested at `tests/superusers.test.ts`)
  - issued token works with `authMiddleware` end-to-end (context populated) ✅
  - tests at `tests/auth.test.ts` mirroring the auth-test style of `collection.test.ts` ✅

### 2.2 [~] Records CRUD

- **Goal:** full records API per collection — the surface the dashboard and end users consume.
- **Done (foundation, landed early):**
  - `src/lib/record-schema.ts`: runtime request schema creator — builds create/update zod schemas from the field metadata stored in `_collections` (per-type constraints: min/max length on text/email/url/date, min/max value on number, `values` enum for select, relation id string; hidden fields excluded; required-with-default fields optional on create; empty patches rejected)
  - field metadata schema (`src/lib/collection.ts`) validates the constraint options per type at collection save time (strict object, no unknown keys)
  - `migrations/001_init.sql` (edited in place, pre-launch): `_superusers` seed metadata now carries `password` min 8 / max 128 and `email` max 254 — collection-level `options.minPasswordLength` removed; superusers create route reads constraints from metadata
- **Scope:**
  - Replace the `records.route.ts` stub: `GET /` (list), `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id`
  - Pagination (page/perPage or cursor — pick one, document), sorting, filtering (initially simple `field=value` params; the full rule language arrives in Phase 3)
  - Hidden fields excluded from all responses (`getNonHiddenCollectionField` already exists)
  - Per-type field validation on write: wire `buildRecordCreateSchema`/`buildRecordUpdateSchema` (done, see foundation) plus `relation` existence checks; `file` (reject until Phase 5)
  - Required/unique enforcement errors mapped to correct codes (reuse `mapD1Error` for constraint failures)
  - Auth collections: password write goes through `hashPassword`, `verifyPassword` never leaks; `password` never returned
  - Guard rails: records API rejects `view` collections for writes (Phase 4 relaxes reads), rejects system collections per rules
- **Files:** `src/routes/records.route.ts`, `src/services/records.service.ts`, `src/lib/record-schema.ts` (done), `tests/records.test.ts`
- **Depends on:** 2.1 (auth for context), 1.2 (middleware)
- **Acceptance:**
  - CRUD roundtrip for a base collection, including validation failures with `VALIDATION_ERROR`/`CONFLICT` codes
  - hidden field (e.g. `password`) never appears in list/get/create/update responses
  - collections with a `null` rule require superuser; collections with an empty (`""`) rule are open to everyone
  - tests at `tests/records.test.ts`

---

## Phase 3 — API rules engine

> The biggest security-critical chunk: compile-time rule validation + runtime rule enforcement.
>
> **Authoritative spec:** [`API_RULES.md`](./API_RULES.md) — where this roadmap and the spec disagree, the spec wins (scope reviewed 2026-10-18).

### 3.1 [x] Rule syntax: lexer

- **Goal:** tokenize the PocketBase-flavored rule language into a token stream.
- **Scope:**
  - Token types: identifiers, `@request.*` macros, the `:isset`/`:changed` modifier suffixes, `@now`, string/number/boolean/`null` literals, operators (`=`, `!=`, `>`, `>=`, `<`, `<=`, `~`, `!~`, `&&`, `||`, `!`), parens; the `?`-family operators and `@collection.*` are lexed as reserved and rejected by the compiler
  - Position-tracked errors (`Unexpected token at line X col Y`) for later user-facing messages
- **Files:** `src/api-rules/lexer.ts`
- **Depends on:** nothing (can start in parallel with Phase 2)
- **Acceptance:** unit tests covering valid/invalid token streams, position reporting.

### 3.2 [x] Rule syntax: parser + AST

- **Goal:** build an AST with clean error messages.
- **Scope:**
  - Pratt or recursive-descent parser; precedence `(` `)` > unary `!` > comparison > `&&` > `||`
  - AST node types exported for the compiler: `BinaryExpr`, `UnaryExpr`, `FieldRef`, `MacroRef`, `NowRef`, `ModifierRef` (`:isset`/`:changed`), `Literal`
- **Files:** `src/api-rules/parser.ts`
- **Depends on:** 3.1
- **Acceptance:** unit tests for precedence, associativity, parenthesization, malformed input errors.

### 3.3 [x] Compiler: validate + compile to SQL

- **Goal:** the "ahead of time evaluated" promise in ARCHITECTURE.md — rules become SQL fragments stored in `_collections` at save time, so request handling never parses rules.
- **Scope:**
  - Validate AST against the collection's fields (field names, types), `@request.auth.*`/`@request.body.*` macros, `@now` and the `:isset`/`:changed` modifiers; relation traversal (`relationField.target.field`) and `@collection.*` joins are deferred to 3.5
  - Produce a parameterized SQL fragment + bound value list; parameterized = injection-safe by construction
  - Output format stored with the collection (spec: `compiledRules` JSON column, `{ sql: "...", slots: [...] }` per action) — keep storing the raw rule text too, so dashboards can edit rules later
- **Files:** `src/api-rules/compiler.ts`, `src/services/collection.service.ts` (wire compilation into create/update), `migrations/001_init.sql` (`compiledRules JSON NOT NULL DEFAULT '{}'`, edited in place per pre-launch policy)
- **Depends on:** 3.1, 3.2, and collection metadata shape from Phase 2
- **Acceptance:**
  - collection create/update rejects invalid rules with 400 `VALIDATION_ERROR` and a readable message
  - valid rules compile deterministically; compiler output unit-tested for the standard rule surface (id/email/fields, `@request.auth.id`, `@request.body.*`, `:isset`/`:changed`, `@now`)

### 3.4 [ ] Runtime rule enforcement in the records layer

- **Goal:** every record action consults the compiled rule; superusers bypass.
- **Scope:**
  - Query builder merges compiled rule SQL into `WHERE` (view/update/delete compile as extra `id = ? AND (<rule-sql>)` terms; list ANDs into the rows and count queries; create merges the predicate into `INSERT … SELECT … WHERE (<rule-sql>)`)
  - Semantics: `null` rule → superuser only (403); `''` → everyone; expression false/NULL → list 200 partial, create 400, view/update/delete 404 (spec §2)
  - Rules never add identifiers to SQL: field refs are compiled at save time, all request values are bound parameters
  - Return 404 (not 403) for rule-filtered single-record reads/updates; locked rules are 403 (pocketbase semantics)
- **Files:** `src/services/records.service.ts`, `src/routes/records.route.ts`
- **Depends on:** 3.3, 2.2
- **Acceptance:**
  - matrix tests: each of the 5 rule actions × (superuser / authed user matched by rule / authed user denied / anonymous attempted)
  - injection attempts in rule strings fail at compile time (no SQL injection possible through rules)
  - no rule parse/compile cost on the request hot path

### 3.5 [ ] Rules v1.1: relation traversal and `@collection.*`

- **Goal:** extend the rule language with `relationField.target.field` chains and `@collection.*` joins (deferred out of v1, see [API_RULES.md](./API_RULES.md) §9).
- **Scope:**
  - Compiler resolves referenced collection metadata (stable `collectionId`) and emits correlated subqueries for single-valued relations
  - Cross-collection invalidation: collection rename/delete/field change recompiles (or rejects) every rule that references the affected collection; dependency list stored with the compiled artifact
- **Files:** `src/api-rules/compiler.ts`, `src/services/collection.service.ts`
- **Depends on:** 3.3, 3.4
- **Acceptance:** chain/join rules compile deterministically; renaming or deleting a referenced collection keeps dependent artifacts correct (recompile or 400); enforcement covered by tests.

---

## Phase 4 — Collections features

### 4.1 [ ] View collections

- **Goal:** SQLite views as virtual collections, queryable like normal collections.
- **Scope:**
  - Add `view` to `COLLECTION_TYPES` (schema, UI messages, tests that currently expect `type: view → 400`)
  - `options.query` (single SELECT statement, validated: single statement, no leading underscores, no pragma/explain, read-only shape)
  - Lifecycle: `CREATE VIEW` on create, `DROP VIEW`+`CREATE VIEW` on query/field changes, `DROP VIEW` on delete; column resolution used to generate the view's `fields` metadata
  - Write guard: records API rejects writes on views; reads respect `viewRule`
- **Files:** `src/lib/collection.ts`, `src/services/collection.service.ts`, `src/routes/records.route.ts`, `tests/collection.test.ts` (type view expectations)
- **Depends on:** 2.2 (records), 3.4 (viewRule enforcement native rules path)
- **Acceptance:** create a view over two collections → list/get works with rule enforcement; invalid query → 400; rename/delete cleans up the view.

### 4.2 [ ] Superuser management via records API

- **Goal:** `_superusers` fully manageable through the same records endpoints (dogfooding).
- **Scope:**
  - Records endpoints already callable as superuser on `_superusers` (write flows through `type: auth` handling → `hashPassword`)
  - Guardrails: can't demote/delete the last superuser; bootstrap window logic (from 2.1) must consider this CRUD path
- **Files:** `src/services/records.service.ts` (auth-collection hooks), `tests/records-auth.test.ts`
- **Depends on:** 2.1, 2.2
- **Acceptance:** superuser list/create/update/delete on `_superusers` via records API with hashing + no password leakage; lockout impossible.

---

## Phase 5 — Files

### 5.1 [ ] `_files` system collection + R2 wiring

- **Goal:** metadata + storage substrate for the `file` field type.
- **Scope:**
  - Migration `003_files.sql`: `_files` table (id, collectionId, recordId, field, filename, size, mime, checksum, storageKey, createdAt/updatedAt) plus the `_collections` system row
  - `wrangler.jsonc`: R2 bucket binding
- **Files:** `migrations/003_files.sql`, `wrangler.jsonc`, `src/config.ts`
- **Depends on:** 1.3
- **Acceptance:** migration applies; `_files` visible in collection list as system collection.

### 5.2 [ ] Upload / serve / delete

- **Goal:** file fields work end to end.
- **Scope:**
  - Writes: multipart-form handling for record create/update; per-record capping, content-type checks, size cap in `file` field options
  - Serve: `GET /api/files/:collectionNameOrId/:recordId/:filename` — access controlled by the record's compiled list/view rules (respect public/private)
  - Delete: on record delete or field replacement → R2 object removal + `_files` cleanup (batch, non-blocking where possible); orphan sweep utility
- **Files:** `src/routes/files.route.ts`, `src/services/files.service.ts`, `src/services/records.service.ts`
- **Depends on:** 5.1, 2.2, 3.4
- **Acceptance:** upload → list/get with clean fields → download (right headers/mime) → replace → delete, with `_files` rows staying consistent; unauthorized download → 404/403 per rule.

---

## Phase 6 — Realtime

### 6.1 [ ] Durable object + subscription protocol

- **Goal:** hibernating-websocket DO broadcasting record changes.
- **Scope:**
  - `src/realtime/realtime.do.ts` (or follow repo's structure); wrangler `durable_objects` binding; migration if a `_sessions`-like ledger is needed (probably not — DO keeps in-memory + sqlite tag subscriptions)
  - Subscribe protocol: client sends `PB_CONNECT`-style message with auth token (query-param token accepted); server validates via `authMiddleware`'s logic, stores per-collection subscriptions in hibernation API state
  - Broadcast hook in `records.service` on create/update/delete; payloads rule-filtered per subscriber
- **Depends on:** 1.3, 2.2 (record change points), 3.4 (rule-filtered broadcasts)
- **Acceptance:** two clients (one matching / one denied by rule) see events accordingly; websockets survive hibernation and still deliver; connections with invalid/expired tokens are rejected.

---

## Phase 7 — Dashboard

> React SPA served by the api server (assets binding), built against flarebase's own public API (dogfooding `authWithPassword`, records, collections).

### 7.1 [ ] SPA scaffold + serving

- **Goal:** build/deploy pipeline for the SPA inside the worker's assets directory.
- **Scope:**
  - Workspace package (per `pnpm-workspace.yaml` + empty `packages/`): Vite + React + TS with strict types
  - Build output into `public/` (or a dedicated `public/dashboard` path) — `ASSETS` fallback: serve `index.html` for non-`/api` paths (SPA routing)
  - Auth session bootstrapping: login screen for superuser (`_superusers` auth-with-password), store token in cookie/localStorage, wire API client with `Authorization: Bearer`
- **Depends on:** 2.1 (login), 2.2 (records read), 4.2 (superuser mgmt done via public API)
- **Acceptance:** `npm run build` emits bundle into the serve path; visiting `/` loads the SPA; `/api/*` still routes to the worker; login works against the live worker.

### 7.2 [ ] Dashboard features

- **Goal:** a usable admin UI.
- **Minimum scope:**
  - Collections manager: list/create/edit collections, field editor (types, required/unique/hidden), indexes editor, rules editor (surfaces compile errors from 3.3)
  - Records browser per collection: table view, server-side pagination/sort/filter, create/edit/delete records (respecting field types; file fields land after Phase 5)
  - Superuser settings: change email/password; add/remove superusers
- **Depends on:** 7.1, plus records/collections APIs
- **Acceptance:** superuser can build a working collection, insert records into it, and query those records — all from the browser UI alone.

---

## Phase 8 — Hardening & release

### 8.1 [ ] Security & operational hardening

- **Scope:**
  - Request body size limits; content-type enforcement
  - Rate limiting on auth endpoints (Cloudflare rate limit binding or DO counter)
  - CORS configuration for browser API access (dashboard + third-party apps)
  - Session management polish: revoke-all-sessions-per-user endpoint, automatic purge of expired `_sessions` rows
- **Depends on:** Phases 1–2 minimum, ideally most features landed
- **Acceptance:** abuse-prone endpoints degrade gracefully; cross-origin API usage behaves as configured.

### 8.2 [ ] Release polish

- **Scope:**
  - Full test suite green (`npm test`), `npm run typecheck` clean
  - `npm run deploy` against a real account verified end to end (auth → collections → records → files → realtime)
  - README update: environment setup, prod secret handling, API surface overview
- **Acceptance:** documented, deployable from a clean checkout.

---

## Suggested critical path

```
1.1 1.2 1.3 (parallel-ish)
        │
      2.1 auth endpoints
        │
      2.2 records CRUD
        │
      3.1 3.2 (can start during 2.x) → 3.3 compiler → 3.4 enforcement
        │
      4.1 views ─ 4.2 superuser mgmt (independent)
        │
      5.1 files migration → 5.2 files API
        │
      6.1 realtime DO
        │
      7.1 dashboard scaffold → 7.2 dashboard features
        │
      8.1 8.2 hardening + release
```

Rules engine (3.x) can be started in parallel with Phase 2 (lexer/parser have no dependencies); it must however land **before** 5.2 (file serving respects record rules) and 6.1 (realtime broadcasts are rule-filtered).

## Digest of invariants to protect

- `NULL` rule = superuser only; `""` rule = open to everyone (documented in migrations `001_init.sql`)
- System collections (list in ARCHITECTURE.md) cannot be deleted; renames and field changes are rejected
- `password` must never appear in API responses, ever
- Rule strings are compiled at collection save time; hot-path SQL is pre-generated and parameterized
- First superuser can be created by anyone; afterwards only superusers manage superusers
- Collection field type changes are rejected (additive-only schema evolution; removed fields keep their columns)
