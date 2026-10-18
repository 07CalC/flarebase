## overview

A pocketbase inspired (not drop in replacement) backend-as-a-service (BaaS) designed for cloudflare workers.

## architecture

- **api server**: a hono application running on cloudflare workers handling all the incoming requests.
- **database**: cloudflare d1 database.
- **object storage**: cloudflare r2 object storage.
- **realtime**: cloudflare durable object with hibernating websockets.
- **dashboard**: react spa served by the api server, made using flarebase itself.

## key concepts

### **collections**:

Everything in flarebase is a collection. collections are just a sqlite table in the d1 database with their metadata stored in a special system collection named `_collections`. collections can be created, updated and deleted using the flarebase dashboard or the api. collections can have any number of fields with different types (string, number, boolean, date, file, etc.) and can have relations to other collections.

Field configs can carry per-type validation options stored inside the fields JSON: `min`/`max` (length bounds for text/email/url/date, value bounds for number), `values` (allowed values for select) and `collectionId` (relation target). the record routes compile these into runtime request validation schemas (`src/lib/record-schema.ts`) at request time, so the stored metadata is the single source of truth for what a valid record body is.

Some collections are system collections and can not be deleted or modified. these includes:
- `_collections`: stores the metadata of all collections.
- `_superusers`: stores the superuser accounts.
- `_sessions`: stores the sessions of the users.
- `_files`: stores the metadata of the files uploaded to the object storage.
- `_migrations`: stores the migrations of the collections.

Collections can be further categorized into three types:
- **base**: collections that are arbitrary tables with no special meaning, for storing any kind of data with no restrictions.
- **view**: a sqlite `view` that is created from a collection or a combination of collections. views can be used to create virtual collections that can be queried like normal collections.
- **auth**: collections that can be used for authentication and authorization. these collections have special fields and methods for handling user accounts, sessions, and permissions.

each collection must have some required fields which are:
- `id`: a unique identifier for the record.

### authentication and authorization

since everything is just a collection, authentication and authorization is handled by the collections themselves.
the `auth` collections have special required fields which can be used for authentication and authorization. these fields are:
- `email`: the email of the user.
- `password`: the password of the user.

the `auth` collections also have special methods for handling authentication and authorization. these methods are:
- `authWithPassword(email: string, password: string)`: authenticates a user with their email and password.

the authorization is handled by the `api rules` which are stored in the `_collections` collection. the `api rules` are a set of rules that define what actions can be performed on a collection and by whom. the `api rules` can be defined using a simple syntax and can be applied to any collection. the full specification (language, compiled storage format, enforcement contract) is in [API_RULES.md](./API_RULES.md).

each incoming request is populated wih the user information (if applicable) before the hitting any route. this is done by the `auth` middleware which checks the request for a valid session and populates the request with the user information if the session is valid.

sessions are the source of truth for issued tokens: a token is only usable while its `_sessions` row exists (matched by the token's `jti`), is not revoked, and is not expired. the lifecycle:
- login (`POST /api/collections/:collectionName/auth/with-password`) verifies the credentials, registers a session row (`jti`, `expiresAt`), and returns the token
- refresh (`POST /api/collections/:collectionName/auth/refresh`) rotates the session: the replacement session is created first, then the old `jti` is revoked, so a failed rotation never logs the caller out
- logout (`POST /api/auth/logout`) revokes the current session; revocation is idempotent and collection-independent because the token is self-describing
- expired rows are purged opportunistically on login and refresh; revoked-but-unexpired rows are never purged early so their tokens stay rejected

api rules are ahead of time evaluated and stored in the `_collections` collection. this means that the rules are evaluated when the collection is created or updated and not when the request is made. this allows for faster request processing since the rules are already evaluated and stored in the database. the sql queries are generated based on the rules and are executed directly on the database without any additional processing.

**superusers** collection is also auth type system collection which is used to store the superuser accounts. superusers have full access to all collections and can perform any action on any collection. superusers can be created, updated and deleted using the flarebase dashboard or the api by other superusers.

superusers can be created by other superusers or by anyone when there are no superusers in the system. this is done to allow for the initial setup of the system. once a superuser is created, only other superusers can create new superusers.
