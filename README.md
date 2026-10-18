# flarebase

A pocketbase inspired (not drop-in replacement) backend-as-a-service (BaaS) designed for cloudflare workers. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design and [ROADMAP.md](./ROADMAP.md) for the implementation plan.

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

## development notes

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
