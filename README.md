# flarebase

A pocketbase inspired (not drop-in replacement) backend-as-a-service (BaaS) designed for cloudflare workers. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design, [ROADMAP.md](./ROADMAP.md) for the implementation plan and [API_RULES.md](./API_RULES.md) for the API rules specification.

## setup

```txt
npm install
npm run dev
```

## configuration

Bindings and vars are declared in `wrangler.jsonc`; local secrets live in `.dev.vars` (copy `.dev.vars.example`, never committed).

| name | kind | required | default | description |
| --- | --- | --- | --- | --- |
| `DB` | binding | yes | — | D1 database holding every collection |
| `FILE_BUCKET` | binding | yes | — | R2 bucket for uploaded files (expects bucket `flarebase-files`) |
| `ASSETS` | binding | yes | — | static assets directory serving the dashboard SPA |
| `JWT_SECRET` | secret | yes | — | HMAC secret for session tokens; set with `npx wrangler secret put JWT_SECRET` |
| `SESSION_TTL_SECONDS` | env var | no | `604800` | session lifetime in seconds (accepted range: 300–2592000, i.e. 5 min – 30 days); requests fail with a clear 500 "misconfigured" error when invalid |

### production

```bash
# create the R2 bucket the FILE_BUCKET binding points at
npx wrangler r2 bucket create flarebase-files

# apply D1 migrations to the remote database
npm run migrate

# set the JWT secret (never ship it inside wrangler.jsonc)
npx wrangler secret put JWT_SECRET

npm run deploy
```

Session TTL can be overridden per deployment by setting `SESSION_TTL_SECONDS` under `vars` in `wrangler.jsonc` or with `npx wrangler secret put` if you want it out of source.

## records api

Records live under `/api/collections/{collection}/records`: `GET /` lists, `GET /{id}` reads, `POST /` creates, `PATCH /{id}` updates and `DELETE /{id}` deletes. Every action is guarded by the collection's API rule (`listRule`, `viewRule`, `createRule`, `updateRule`, `deleteRule`): `null` means superusers only, `""` is open to everyone, and expressions are evaluated server-side per [API_RULES.md](./API_RULES.md) (superusers bypass all rules).

Rules can traverse relation fields (`author.team.name = "Red"`) and express back-relations with `@collection.*` (`@collection.posts.author = id`). Both compile to correlated subqueries at collection save time; the artifact records the referenced collection ids, so renaming or changing a referenced collection recompiles dependent rules (or rejects the change with `400` when a rule would break), and deleting a referenced collection is rejected while rules point at it.

The list endpoint supports:

| query param | default | description |
| --- | --- | --- |
| `page` | `1` | 1-based page number |
| `perPage` | `30` | items per page, maximum `500` |
| `sort` | `-createdAt,id` | comma-separated field list; a `-` prefix sorts descending |
| `{field}` | — | exact-match filter, one query param per field; numbers, booleans and dates are coerced/normalized like writes |

The list response `data` is `{ page, perPage, totalItems, totalPages, items }`. Write requests are validated against the field metadata stored in `_collections` (per-type constraints, `values`, relation targets), dates are normalized to RFC 3339 UTC with milliseconds, and hidden fields are never part of a response.

## view collections

A collection created with `"type": "view"` is backed by a SQLite view instead of a table. The create payload carries the single-statement query in `options.query` and the `fields` are resolved from the query columns automatically, so `fields`/`indexes` are rejected both on create and on later patches:

```jsonc
{
  "name": "post_overview",
  "type": "view",
  "options": {
    "query": "SELECT p.id AS id, p.title AS title, u.email AS authorEmail FROM posts p LEFT JOIN users u ON u.id = p.author"
  },
  "listRule": "views > 10",
  "viewRule": ""
}
```

View queries must be one `SELECT`/`WITH` statement and must expose an `id` column; identifiers starting with `_` or `sqlite_` and any `password` reference are rejected so a view can never surface system tables or stored hashes. Views are read-only through the records API (writes return `400`); reads use the same rules, filters and pagination as normal collections — but only the resolved columns exist, with `-createdAt,id` as the default sort only when `createdAt` was selected (`id` alone otherwise). Field types are inferred from the query's declared column types (`BOOL*` → bool, numeric → number, everything else → text), so view rules have no date-class field and `@now` comparisons are unavailable there. Changing `options.query` (or the name) rebuilds the view and re-resolves its fields; a patch that would leave a stored rule referencing a removed column is rejected and the previous view keeps serving. Deleting the collection drops the view.

Note that dropping a base collection does not cascade to views that select from it (SQLite allows the drop and the view errors on its next read until its query is patched or it is deleted).

## development notes

Tests run inside the real Workers runtime (workerd) via `@cloudflare/vitest-plugin`:

```txt
npm test          # single run
npm run test:watch # watch mode
npm run typecheck  # workers + tests projects
```

The suite calls `src/index.ts` through `worker.fetch(request, env, ctx)` with a real `ExecutionContext` (so `waitUntil` behaves exactly like production), uses local D1 bindings with the migrations applied automatically, and resets the database to a seeded baseline before each test.

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```txt
npm run cf-typegen
```

Pass the `CloudflareBindings` as generics when instantiating `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```

```txt
npm run deploy
```
