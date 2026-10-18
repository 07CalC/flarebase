# API rules — specification

Status: **reviewed** (2026-10-18) — scope decisions are locked; ready for implementation.
This document is the source of truth for the rule language, its compile-time validation,
its storage format and its runtime enforcement. `ARCHITECTURE.md` states the invariants;
this file pins the details, so lexer, parser, compiler and records enforcement can be
built against a frozen contract.

**Review decisions:** relation traversal and `@collection.*` are deferred to a follow-up
task (roadmap 3.5); rules resolve `@request.auth.*` against the sanitized user; the
`:isset`, `:changed` and `@now` specials are part of v1.

---

## 1. Purpose

Every collection carries five rules, stored as raw text in `_collections`:

| column | guards |
| --- | --- |
| `listRule` | listing records (`GET /records`) |
| `viewRule` | reading one record (`GET /records/:id`) |
| `createRule` | creating a record (`POST /records`) |
| `updateRule` | updating a record (`PATCH /records/:id`) |
| `deleteRule` | deleting a record (`DELETE /records/:id`) |

A rule answers two questions at once: *who* may perform the action, and *which records*
the action applies to. Rules are part of the collection schema: they are validated and
compiled when the collection is saved, never parsed on the request hot path.

Out of v1 scope: relation traversal, `@collection.*`, the `:length` / `:lower` modifiers,
datetime macros other than `@now`, the any-of (`?`) operator family, `manageRule` — all
listed in §9 with reasons.

## 2. Core semantics

A rule has exactly three states:

| stored value | meaning | non-superuser result |
| --- | --- | --- |
| `null` (or omitted) | locked — superusers only | `403` |
| `""` (exactly empty) | open — everyone, including anonymous | allowed |
| non-empty expression | evaluated per request | depends on the result (table below) |

- **Superusers bypass everything.** A request authenticated against `_superusers` skips
  all rule checks for all actions, including locked rules.
- **A rule is a predicate, never a grant.** Passing only allows the action that carries
  it; it never implies any other action or collection.
- **The list rule is a row filter.** An expression that is false or `NULL` for a row only
  removes that row from the result. A 200 with fewer (possibly zero) items is success,
  not a denial.
- **Missing collection → 404** precedes all rule handling.
- A whitespace-only or comment-only rule string is *not* "open" — it is a compile error;
  only the exact empty string is the open state.

Client-visible status matrix (PocketBase parity for all five actions):

| action | locked rule, non-superuser | expression false / `NULL` | id not found |
| --- | --- | --- | --- |
| list | `403` | `200` with empty/partial items | — |
| view | `403` | `404` | `404` |
| create | `403` | `400` `"Failed to create record"` | — |
| update | `403` | `404` | `404` |
| delete | `403` | `404` | `404` |

Rationale for create: PocketBase documents "400 for unsatisfied createRule". A denied
create is reported as `400 VALIDATION_ERROR` with a deliberately generic message so the
rule itself is not disclosed. View/update/delete cannot distinguish "denied" from
"missing" by id — that is intentional, it removes an existence oracle.

## 3. Rule language (v1)

### 3.1 Grammar

```
rule      := orExpr

orExpr    := andExpr ( "||" andExpr )*
andExpr   := unary ( "&&" unary )*
unary     := "!" unary
           | "(" orExpr ")"
           | comparison
           | boolean

comparison:= value op value
op        := "=" | "!=" | ">" | ">=" | "<" | "<=" | "~" | "!~"

value     := field | macro | now | literal | boolean
field     := IDENT
macro     := "@request" "." ( "auth" | "body" ) "." IDENT
now       := "@now"
literal   := STRING | NUMBER | "true" | "false" | "null"
boolean   := "true" | "false" | isset | changed
isset     := "@request" "." ( "auth" | "body" ) "." IDENT ":isset"
changed   := "@request.body" "." IDENT ":changed"
```

- Comparisons never chain: `a = b = c` is a parse error. There is no arithmetic.
- `!` applies to a comparison, a parenthesized group or a boolean expression — never to
  a bare non-boolean operand (`!status` is invalid).
- Precedence, lowest to highest: `||` → `&&` → `!` → parentheses. Comparisons are leaves.
- `true`/`false` and modifier expressions are boolean primaries: valid as a whole rule,
  combinable with `&&`/`||`/`!`, or compared with `true`/`false` PocketBase-style
  (`@request.body.role:changed = false`).
- SQL evaluation is set-based and `@request.*` values are constants per statement, so the
  absence of short-circuiting is not observable.

**Reserved, lexed, rejected with "not supported yet"** (clear message, not a lexer
error): `?=`, `?!=`, `?>`, `?>=`, `?<`, `?<=`, `?~`, `?!~`, `@collection.*`, datetime
macros other than `@now` (`@todayStart`, …), `@request.query.*`, `@request.headers.*`,
`@request.method`, `@request.context`, and the `:length` / `:lower` modifiers. Other
modifier misuse is a specific compile error, not a generic one (`:changed` outside
`updateRule`, a modifier attached to a plain field, etc. — §3.3).

### 3.2 Tokens

| token | form | notes |
| --- | --- | --- |
| `IDENT` | `[A-Za-z_][A-Za-z0-9_]*` | same shape as field/collection names |
| `STRING` | `"…"` or `'…'` | escapes: `\\`, `\"`, `\'`; no raw newlines |
| `NUMBER` | `-?[0-9]+(\.[0-9]+)?` | no exponent; bound as JS number |
| keywords | `true`, `false`, `null` | recognized in operand/boolean position only |
| macro | `@request.auth.<ident>`, `@request.body.<ident>` | path segment read as IDENT |
| now | `@now` | request-scoped timestamp |
| modifier | `:isset`, `:changed` | suffix on a macro path |
| comments | `//` to end of line | skipped |
| length | max 2048 chars | existing `ruleSchema` limit |

Whitespace between tokens is free. Rule text is stored byte-for-byte as submitted (no
trimming, no normalization); compilation works from the exact stored string.

### 3.3 Operands

**Record fields** — bare identifiers:

- Must exist in the collection's `fields` metadata (`id`, `createdAt`, `updatedAt` are
  implicit and always allowed; `createdAt`/`updatedAt` are date-class).
- `hidden: true` fields are allowed; hidden only affects API projection, and rules run
  server-side.
- `json` and `file` fields are rejected in v1 (no defined comparison semantics yet).
- Any path ending in `password` is permanently rejected (never comparable, never
  bindable).

**`@request.auth.<field>`** — the authenticated record:

- Resolved from the sanitized auth context (`password` and hidden fields stripped —
  `sanitizeAuthRecord`). Hidden fields resolve to `null`; this is a deliberate,
  fail-closed limitation, to be revisited with field-level permissions.
- Anonymous requests: every `@request.auth.*` is `null`.
- `@request.auth.password` is a compile error.
- Other field names are accepted at compile time (the requester's collection is unknown)
  and resolve at runtime; missing field → `null`.

**`@request.body.<field>`** — the validated request payload:

- Legal only in `createRule` and `updateRule`; list/view/delete have no body → compile
  error.
- The field must exist in metadata and be non-hidden; `password` is rejected.
- Values are post-validation and post-normalization (e.g. dates already normalized,
  booleans already coerced) — exactly what the write path would store. This keeps
  `:changed` from producing false positives.
- Create: exactly the submitted fields. Fields absent from the payload are `null`
  (metadata defaults are *not* applied — that is what plain field refs are for, §4.1).
- Update: exactly the submitted patch (partial).

**`@now`** — the request's UTC instant:

- Resolves once per request to an RFC 3339 string with millisecond precision and `Z`
  suffix (`2026-10-18T12:34:56.789Z`) — the same normalized form records store (2.2 date
  normalization is the prerequisite; until it lands, comparisons are lexicographic on
  whatever strings are stored). Every `@now` occurrence in one request is identical.
- Legal in all five rules; typed as datetime (§3.5): comparable only with `date` fields,
  `@request.body.<dateField>` and dynamic `@request.auth.*`.

**Modifier expressions** — boolean primaries:

- `@request.body.f:isset` / `@request.auth.f:isset` — true iff `f` was submitted in the
  payload / is present in the sanitized auth record. Anonymous → `false` for auth fields.
  The field name obeys the base macro's rules (exists for body, non-hidden, not
  `password`, supported type; body availability applies).
- `@request.body.f:changed` — true iff `f` is submitted **and** differs from the current
  row value. Legal only in `updateRule`: create has no previous value (compile error —
  use `:isset`). Compiled, not evaluated in JS:
  `(?isset AND "f" IS NOT ?submitted)` — `IS NOT` gives NULL-safe inequality, so a
  stored `NULL` and a submitted value count as changed.
- Modifiers attach only to `@request.*` macros; plain fields, `@now` and literal paths
  reject them. `:changed` also rejects `@request.auth.*`.

Availability:

| operand | list | view | create | update | delete |
| --- | --- | --- | --- | --- | --- |
| record field | row | row | candidate row | current row | row |
| `@request.auth.*` | yes | yes | yes | yes | yes |
| `@request.body.*` | no | no | yes | yes | no |
| `@now` | yes | yes | yes | yes | yes |
| `:isset` (body / auth) | no / yes | no / yes | yes / yes | yes / yes | no / yes |
| `:changed` (body) | no | no | no | yes | no |

### 3.4 Operator semantics

| op | SQL | semantics |
| --- | --- | --- |
| `=` `!=` | `=` / `!=` | typing per §3.5; `= null` → `IS NULL`, `!= null` → `IS NOT NULL` (either operand order) |
| `>` `>=` `<` `<=` | same | numbers numerically; string-compatible values lexicographically (ISO-8601 dates compare correctly as text) |
| `~` | `LIKE` | contains match. The right operand is wrapped `%value%` unless it already contains `%`; `_` remains a single-char wildcard; matching is case-insensitive for ASCII (SQLite default) |
| `!~` | `NOT LIKE` | negation of the above |
| `&&` `||` | `AND` `OR` | SQL three-valued logic |
| `!` | `NOT` | SQL `NOT`; `NOT NULL` is `NULL` |

Modifier expansions:

- `@request.body.f:isset` (or auth) → `(?1)` with an `isset` slot resolved to `1`/`0`.
- `@request.body.f:changed` → `(?1 AND ("f" IS NOT ?2))`; `?1` is the `isset` slot, `?2`
  the `body` slot.
- Comparisons against booleans bind `true`/`false` as `1`/`0`.

**Null handling** is SQL three-valued logic, documented explicitly because it is the
usual source of confusion:

- Comparisons with `null`/`NULL` yield `NULL`; `WHERE NULL` behaves as false.
- Optional columns are genuinely `NULL` when never written, while text fields can also
  hold `""`. Both are meaningful: `field = ""` never matches `NULL`, `field = null`
  matches only `NULL`.
- `= null` / `!= null` are special-cased to `IS NULL` / `IS NOT NULL` (so
  `null = null` is true).
- Anonymous `@request.auth.id` is `NULL`, so the idiom
  `@request.auth.id != ""` is false for anonymous requests (`NULL != ''` is `NULL`),
  which is the intended "authenticated users only" behavior without a special case.

LIKE examples: `title ~ "lorem"` → `"title" LIKE '%lorem%'`;
`title ~ "Lorem%"` → `"title" LIKE 'Lorem%'`.

### 3.5 Compile-time type checking

Operand classes:

| class | operand types | comparable with |
| --- | --- | --- |
| string-compatible | `text`, `email`, `url`, `date`, `select`, `relation` fields | same class: `=`, `!=`, ordered, `~`, `!~` |
| numeric | `number` fields | same class: `=`, `!=`, ordered |
| boolean | `bool` fields, `true`/`false`, `:isset`, `:changed` | same class: `=`, `!=` only |
| datetime | `@now` | `date` operands: `=`, `!=`, ordered |
| reserved | `json`, `file` fields | rejected in v1 |

Rules:

- Both sides of a comparison must be the same class, or one side must be `null`, or one
  side must be `@request.auth.*` (dynamically typed, no static check).
- `@request.body.<field>` takes the field's class from metadata.
- `@now` is only comparable with `date` operands (`date` field, body date field, dynamic
  macro).
- `:isset` / `:changed` are boolean and may only be attached to `@request.*` macros.
- Literals must match the class: `views > "5"` and `title = 5` are compile errors. No
  implicit coercion.

### 3.6 Compile-time validation

The compiler reports all violations for all five rules in one pass, each with a rule
path and a source position:

```
listRule: unknown field "ownr" (line 1, column 1)
updateRule: cannot compare number field "views" with string (line 1, column 13)
createRule: :changed is only available in the update rule; use :isset
listRule: @request.body is not available in list/view/delete rules
```

Collection create/patch returns `400 VALIDATION_ERROR` with the aggregated message. No
invalid rule is ever stored.

## 4. Evaluation contexts

### 4.1 Record context per action

| action | record operand resolves to | body operand |
| --- | --- | --- |
| list | each persisted row (per-row filter) | — |
| view | the persisted row | — |
| create | **candidate row** = validated payload overlaid on metadata defaults; no default and not submitted → `null`; hidden fields come from defaults | submitted fields only |
| update | **current, pre-update row** — SQL `WHERE` sees old values | submitted patch |
| delete | the persisted row | — |

Consequences worth spelling out:

- `createRule: status = "draft"` works when `status` defaults to `"draft"` even if the
  client omits it; `@request.body.status` is `null` in that same request. Use plain field
  refs to reason about the resulting record, `@request.body.*` to reason about what the
  client sent.
- `updateRule: status = "draft"` guards *the state it is leaving*; to constrain the new
  value use `@request.body.status`. A rule that must check both:
  `author = @request.auth.id && status != "archived" && (@request.body.status = null || @request.body.status = "draft" || @request.body.status = "published")`.
- "Clients may not change `status`" is simply
  `@request.body.status:changed = false` (equivalent to
  `@request.body.status:isset = false || @request.body.status = status`).
- On update, fields not present in the patch keep their current values in the row, so
  `author = @request.auth.id` is stable regardless of the patch.

### 4.2 The auth context never carries secrets

Rules see the same sanitized user object as every other consumer
(`sanitizeAuthRecord`): `password` and hidden fields are absent. Combined with the
compile-time `password` ban, no rule can read or compare credentials.

## 5. Compilation and storage

### 5.1 Raw text plus compiled artifact

`_collections` keeps the raw rule text (dashboard-editable, returned by the collections
API) and gains one internal column:

```sql
compiledRules JSON NOT NULL DEFAULT '{}'
```

The artifact is a map keyed by the five rule columns. A missing key or JSON `null` means
the rule is locked.

Row variant (used by `listRule`, `viewRule`, `updateRule`, `deleteRule`) — field refs
compile to quoted column identifiers:

```json
{
  "listRule": {
    "sql": "((\"author\" = ?) AND (\"status\" = ?))",
    "slots": [
      { "kind": "auth", "path": "id" },
      { "kind": "literal", "value": "draft" }
    ]
  },
  "updateRule": {
    "sql": "((? AND (\"status\" IS NOT ?)) = 0)",
    "slots": [
      { "kind": "isset", "source": "body", "path": "status" },
      { "kind": "body", "path": "status" }
    ]
  }
}
```

Candidate variant (used by `createRule`) — field refs compile to `record` slots resolved
from the candidate row at request time:

```json
{
  "createRule": {
    "sql": "(? = ?)",
    "slots": [
      { "kind": "record", "path": "author" },
      { "kind": "auth", "path": "id" }
    ]
  }
}
```

Invariants:

- `sql` is a fully parenthesized boolean expression (canonical form, no
  precedence ambiguity) with bare `?` placeholders that appear in `slots` order
  (left to right). Identifiers are quoted with `quoteIdent` and only ever
  come from validated metadata — never from rule text. Values are always bound.
- `""` and `true` → `{ "sql": "1", "slots": [] }`; `false` → `{ "sql": "0", "slots": [] }`.
  The request path may short-circuit these, but the artifact stays uniform.
- Slots: `literal` (fixed at compile time), `auth` (`@request.auth.<path>`), `body`
  (`@request.body.<path>`), `record` (candidate row field, create only), `isset`
  (`@request.*.<path>` presence → `1`/`0`), `now` (the request timestamp). D1 bind values
  are string/number/null; booleans normalize to `1`/`0` when resolved.
- Compilation is deterministic: same rule + same field metadata ⇒ byte-identical
  artifact (unit-tested).
- Compilation is pure in v1: operands are limited to this collection's fields and request
  macros, so no database lookups are needed to compile.

### 5.2 When compilation happens

- `createCollection` and `updateCollectionById` compile the **effective** rule set against
  the **effective** field list, and write text + artifact in the same statement. Invalid
  rules never persist.
- Any field change recompiles all five rules of that collection. Removing or renaming a
  field that a stored rule references makes the patch fail with `400`, unless the same
  patch updates the offending rule(s). Renaming a field is remove+add in the metadata
  model, so "rename + fix rules" is one PATCH.
- Renaming a collection does not invalidate artifacts: they reference columns, not the
  table name (one of the reasons relation traversal is deferred, §9).
- System collections use the same path; their seeded rules are `null`.

### 5.3 Loading at request time

- The records layer resolves collections through an internal getter that also loads and
  parses `compiledRules`; the public collection endpoints' `COLLECTION_SELECT` is
  unchanged, so artifacts are never serialized into collection API responses.
- For a non-empty, non-locked rule, a missing/invalid artifact is corrupt metadata and
  fails closed with `500 DATABASE_ERROR`, consistent with `parseJsonField` behavior.

## 6. Enforcement

### 6.1 Per-request flow

1. Resolve the collection by name/id → `404` if missing.
2. If `auth.isSuperUser` → skip rules entirely.
3. Locked rule (`null`) → `403` (reuse `superUserRequired` semantics/message).
4. Action-specific request handling (body validation + normalization for create/update).
5. Materialize rule values from the request context and bind them into the SQL.
6. Execute; map "no row matched" to the status in §2.

Locked-rule check runs before body validation, so a non-superuser never learns anything
about payload handling on a locked collection.

### 6.2 SQL integration

`resolveRule(artifact, { auth, body?, record?, now }) → { sql, values }` turns a compiled
artifact into a concrete parameterized fragment. Missing auth/body/record resolve to
`null`, `isset` slots resolve to `1`/`0`, and `now` is the request timestamp computed
once. A slot kind that cannot be satisfied is a compiler guarantee violation → `500`.

| action | pattern |
| --- | --- |
| list | `SELECT … FROM "t" WHERE (<rule-sql>) [AND user filters] ORDER BY … LIMIT …`; the count query repeats the same WHERE |
| view | `SELECT … FROM "t" WHERE id = ? AND (<rule-sql>)` → no row = `404` |
| create | `INSERT INTO "t" (cols) SELECT ?values WHERE (<rule-sql>) RETURNING *` → no row = `400` |
| update | `UPDATE "t" SET … WHERE id = ? AND (<rule-sql>) RETURNING *` → no row = `404` |
| delete | `DELETE FROM "t" WHERE id = ? AND (<rule-sql>)` → no row = `404` |

Notes:

- The create pattern merges the rule predicate into the insert statement itself: the
  check and the write are atomic, and the same shape composes with the existing
  first-superuser `NOT EXISTS` bootstrap guard.
- Rule fragments use bare `?` placeholders; the composing query keeps value order aligned
  with textual placeholder order (or renumbers via a param builder). Rules never add
  identifiers to the SQL string.
- Empty-string rules append no predicate at all; locked rules never reach SQL.
- Response projection is unchanged by rules: hidden fields are still stripped by the
  records layer (`getNonHiddenCollectionField`), rules only decide *which* rows/actions
  are reachable.

### 6.3 Locked and open fast paths

- `null` → `403` before any record SQL.
- `""` → allowed; no predicate appended, artifact not required (this includes seeded
  system collections).
- expression → append `(<rule-sql>)`.

### 6.4 Future consumers

- Phase 5 file serving consults the target record's compiled view/list rules.
- Phase 6 realtime broadcasts are filtered per subscriber with the same artifacts.

## 7. Security properties

- **Injection-safe by construction**: rule text never reaches SQL. Identifiers come from
  validated metadata and are quoted; all values, including `LIKE` patterns and modifier
  values, are bound. `@now` is a bound timestamp, not a SQL function call.
- **No secret access**: `password` is unbindable in any rule path; the auth context is
  sanitized, so hidden auth fields also resolve to `null`.
- **Fail closed**: missing/invalid artifacts and impossible slots are `500`s. There is no
  path where an unparsed or partially parsed rule silently allows an action.
- **No existence oracle**: view/update/delete answer `404` for both missing and denied
  ids; list counts only ever reflect rows the rule already allows.
- **Least disclosure on denial**: locked rules return a generic `403`; denied creates
  return a generic `400` that does not describe the rule.
- **List timing**: result-size differences are visible by design (PB adds a rate-limit
  timing mitigation; deferred, §9).

## 8. Worked examples

Collection `posts`: `title:text`, `status:select(draft|published)`, `author:relation`,
`views:number`, `featured:bool`, `publishAt:date`.

| intent | rule |
| --- | --- |
| public listing | `""` |
| authenticated users only | `@request.auth.id != ""` |
| own drafts only (list) | `author = @request.auth.id && status = "draft"` |
| published, or own | `status = "published" \|\| author = @request.auth.id` |
| force ownership at create | `@request.body.author = @request.auth.id && @request.body.featured != true` |
| update only your own, non-archived rows | `author = @request.auth.id && status != "archived"` |
| clients may not change status (update) | `@request.body.status:changed = false` |
| publish date cannot be in the past | `@request.body.publishAt >= @now` |
| only popular rows may be updated | `views >= 100 && author = @request.auth.id` |
| superusers only | `null` |
| nobody (not even via expression) | `false` |

## 9. Deferred (explicitly not in v1)

| feature | reason / path back |
| --- | --- |
| relation traversal `rel.field`, `@collection.*` | compiled artifacts would embed other collections' physical names; renames/deletes would require cross-collection recompilation and dependency tracking. Roadmap 3.5, with a dependency-aware recompile step. |
| `?=` `?~` and the rest of the any-of family | only meaningful with multi-value fields (multi-relation/multi-select/multi-file), which the schema does not have yet |
| `:length` modifier | needs multi-value fields to be meaningful |
| `:lower` modifier | SQLite `LOWER` is ASCII-only without ICU; needs a deliberate collation story |
| datetime macros beyond `@now` (`@todayStart`, `@monthStart`, …) | keep v1 to one instant; add with date utilities in a later pass |
| `@request.query.*`, `@request.headers.*`, `@request.method`, `@request.context` | not needed for access control v1; `@request.query` in rules is a foot-gun |
| `manageRule` | PocketBase's auth-collection cross-user management feature; flarebase has no equivalent flow yet |
| list timing mitigation | hardening only; PocketBase rate-limits repeated list probes |
| `filter` query param | 2.2 ships a simple form; the lexer/parser here will later back the full filter language |

## 10. Implementation plan

| step | files | notes |
| --- | --- | --- |
| 3.1 lexer | `src/api-rules/lexer.ts` (+ token types) | unit tests: token streams, escapes, positions, modifiers, reserved tokens |
| 3.2 parser + AST | `src/api-rules/parser.ts` | unit tests: precedence, grouping, malformed input, error positions |
| 3.3 compiler + resolver | `src/api-rules/compiler.ts` | unit tests: type checks, modifier expansions, `@now`, artifact determinism, slot order; wire into `collection.service.ts`; add `compiledRules` by editing `migrations/001_init.sql` (pre-launch policy; local dev state must be reset); update rule fixtures in `tests/collection.test.ts` (e.g. the `owner` field) |
| 3.4 enforcement | `src/routes/records.route.ts`, `src/services/records.service.ts` | depends on 2.2 records CRUD; matrix tests (`tests/rules.test.ts`): 5 actions × superuser / matching user / non-matching user / anonymous, plus injection attempts, modifiers, `@now`, and locked/open fast paths |

The compiler (3.1–3.3) has no dependency on 2.2 and can land first; enforcement lands
together with (or immediately after) the records CRUD routes, since each route needs its
rule gate anyway.
