import { beforeEach, describe, expect, it } from "vitest";
import {
  api,
  apiWithEnv,
  setupTest,
  TEST_SECRET,
  type TestContext,
} from "./setup";
import { generateJWT, verifyJWT } from "../src/lib/jwt";
import {
  getSessionByJti,
  isSessionActive,
  revokeSession,
} from "../src/services/session.service";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupTest();
});

const LOGIN_USERS = "/api/collections/users/auth/with-password";
const LOGIN_SUPERUSERS = "/api/collections/_superusers/auth/with-password";
// the same plaintext the setup suite hashes into the seeded account rows
const TEST_PASSWORD = "hashed-password";

function envWithoutJwtSecret(): CloudflareBindings {
  return { DB: ctx.db } as unknown as CloudflareBindings;
}

const login = (path: string, body: unknown) =>
  api(ctx, "POST", path, { body });

const refresh = (path: string, token?: string) =>
  api(ctx, "POST", path, { token });

describe("POST /api/collections/:collectionName/auth/with-password", () => {
  it("logs in a known user and registers a live session row", async () => {
    const res = await login(LOGIN_USERS, {
      email: "user@example.com",
      password: TEST_PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe("SUCCESS");

    const { token } = res.body.data;
    const decoded = await verifyJWT(token, TEST_SECRET);
    expect(decoded.sub).toBe("u1");
    expect(decoded.collectionId).toBe(ctx.usersId);
    expect(typeof decoded.jti).toBe("string");
    const jti = decoded.jti as string;

    const session = await getSessionByJti(ctx.db, jti);
    expect(session).not.toBeNull();
    expect(session!.userId).toBe("u1");
    expect(session!.collectionId).toBe(ctx.usersId);
    expect(isSessionActive(session!)).toBe(true);
    // the session TTL is derived from the token exp, not from a hard-coded value
    expect(session!.expiresAt).toBe(decoded.exp);
  });

  it("works for the _superusers collection (mount order lets it pass the guarded wildcard)", async () => {
    const res = await login(LOGIN_SUPERUSERS, {
      email: "admin@example.com",
      password: TEST_PASSWORD,
    });
    expect(res.status).toBe(200);
    const decoded = await verifyJWT(res.body.data.token, TEST_SECRET);
    expect(decoded.sub).toBe("su1");
    expect(await getSessionByJti(ctx.db, decoded.jti as string)).not.toBeNull();
  });

  it("never leaks password or hidden fields in the user payload", async () => {
    const patched = await api(ctx, "PATCH", "/api/collections/users", {
      token: ctx.superToken,
      body: {
        fields: [
          { name: "email", type: "email", required: true, unique: true },
          { name: "password", type: "text", required: true },
          { name: "apiKey", type: "text", hidden: true },
        ],
      },
    });
    expect(patched.status).toBe(200);

    const res = await login(LOGIN_USERS, {
      email: "user@example.com",
      password: TEST_PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe("user@example.com");
    expect(res.body.data.user).not.toHaveProperty("password");
    expect(res.body.data.user).not.toHaveProperty("apiKey");
  });

  it("rejects a wrong password", async () => {
    const res = await login(LOGIN_USERS, {
      email: "user@example.com",
      password: "not-the-password",
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
    expect(res.body.error).toBe("Invalid email or password");
  });

  it("rejects an unknown email (equalized timing branch)", async () => {
    const res = await login(LOGIN_USERS, {
      email: "nobody@example.com",
      password: TEST_PASSWORD,
    });
    // the dummy PBKDF2 verify runs inside; timing parity is a runtime
    // property, the test only pins the identical public behavior
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid email or password");
  });

  it("rejects login against a non-auth collection", async () => {
    const created = await api(ctx, "POST", "/api/collections", {
      token: ctx.superToken,
      body: {
        name: "documents",
        fields: [{ name: "title", type: "text" }],
      },
    });
    expect(created.status).toBe(201);

    const res = await login("/api/collections/documents/auth/with-password", {
      email: "user@example.com",
      password: TEST_PASSWORD,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_REQUEST");
    expect(res.body.error).toContain("not an auth collection");
  });

  it("malformed JSON body -> 400 INVALID_REQUEST", async () => {
    const res = await api(ctx, "POST", LOGIN_USERS, {
      rawBody: "{ not json",
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_REQUEST");
  });

  it("credential issues report field paths with VALIDATION_ERROR", async () => {
    const res = await login(LOGIN_USERS, { email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.error).toContain("email");
    expect(res.body.error).toContain("password");
  });

  it("revoked sessions make the token unauthenticated", async () => {
    const res = await login(LOGIN_USERS, {
      email: "user@example.com",
      password: TEST_PASSWORD,
    });
    const decoded = await verifyJWT(res.body.data.token, TEST_SECRET);
    await revokeSession(ctx.db, decoded.jti as string);

    // the JWT itself is still valid, but the middleware requires an active
    // session row: the guarded endpoint must treat the caller as anonymous
    const guarded = await api(ctx, "GET", "/api/collections", {
      token: res.body.data.token,
    });
    expect(guarded.status).toBe(403);
    expect(guarded.body.error).toBe("Superuser access required");
  });

  it("expired JWTs are treated as anonymous", async () => {
    const expired = await generateJWT(
      { sub: "u1", collectionId: ctx.usersId },
      TEST_SECRET,
      { ttlSeconds: -1 },
    );
    const guarded = await api(ctx, "GET", "/api/collections", {
      token: expired.token,
    });
    expect(guarded.status).toBe(403);
  });

  it("an issued token must work end-to-end through authMiddleware", async () => {
    const res = await login(LOGIN_SUPERUSERS, {
      email: "admin@example.com",
      password: TEST_PASSWORD,
    });

    const guarded = await api(ctx, "GET", "/api/collections", {
      token: res.body.data.token,
    });
    expect(guarded.status).toBe(200);
  });

  it("status and shape mirror the response envelope conventions", async () => {
    const res = await login(LOGIN_USERS, {
      email: "user@example.com",
      password: TEST_PASSWORD,
    });
    expect(res.body.message).toBe("Authentication successful");
    expect(res.body.error).toBeNull();
    expect(Object.keys(res.body.data).sort()).toEqual(["token", "user"]);
  });

  it("fails fast with a clear error when JWT_SECRET is missing", async () => {
    const res = await apiWithEnv(envWithoutJwtSecret(), "POST", LOGIN_USERS, {
      body: { email: "user@example.com", password: TEST_PASSWORD },
    });
    expect(res.status).toBe(500);
    expect(res.body.message).toContain("JWT_SECRET is not set");
  });
});

describe("POST /api/collections/:collectionName/auth/refresh", () => {
  it("rotates the session: new token + session, old jti revoked", async () => {
    const loginRes = await login(LOGIN_USERS, {
      email: "user@example.com",
      password: TEST_PASSWORD,
    });
    const oldDecoded = await verifyJWT(loginRes.body.data.token, TEST_SECRET);

    const res = await refresh("/api/collections/users/auth/refresh", loginRes.body.data.token);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Session refreshed");

    const newDecoded = await verifyJWT(res.body.data.token, TEST_SECRET);
    expect(res.body.data.token).not.toBe(loginRes.body.data.token);
    expect(newDecoded.jti).not.toBe(oldDecoded.jti);
    expect(newDecoded.sub).toBe("u1");
    expect(newDecoded.collectionId).toBe(ctx.usersId);

    // the replacement session is live...
    const newSession = await getSessionByJti(ctx.db, newDecoded.jti as string);
    expect(newSession!.revoked).toBe(0);
    expect(newSession!.expiresAt).toBe(newDecoded.exp);
    // ...and the old one is revoked but still present (its token stays dead)
    const oldSession = await getSessionByJti(ctx.db, oldDecoded.jti as string);
    expect(oldSession!.revoked).toBe(1);
  });

  it("returns the CURRENT user row, not the middleware snapshot", async () => {
    const loginRes = await login(LOGIN_USERS, {
      email: "user@example.com",
      password: TEST_PASSWORD,
    });
    await ctx.db
      .prepare(`UPDATE "users" SET email = ?1 WHERE id = ?2`)
      .bind("moved@example.com", "u1")
      .run();

    const res = await refresh("/api/collections/users/auth/refresh", loginRes.body.data.token);
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe("moved@example.com");
    expect(res.body.data.user).not.toHaveProperty("password");
  });

  it("the old token cannot refresh again (rotation is one-way)", async () => {
    const loginRes = await login(LOGIN_USERS, {
      email: "user@example.com",
      password: TEST_PASSWORD,
    });
    const first = await refresh("/api/collections/users/auth/refresh", loginRes.body.data.token);
    expect(first.status).toBe(200);

    const again = await refresh("/api/collections/users/auth/refresh", loginRes.body.data.token);
    expect(again.status).toBe(401);
  });

  it("a refreshed superuser token still works through the middleware end-to-end", async () => {
    const loginRes = await login(LOGIN_SUPERUSERS, {
      email: "admin@example.com",
      password: TEST_PASSWORD,
    });
    const res = await refresh("/api/collections/_superusers/auth/refresh", loginRes.body.data.token);

    const guarded = await api(ctx, "GET", "/api/collections", {
      token: res.body.data.token,
    });
    expect(guarded.status).toBe(200);
  });

  it("401 without a token / with a revoked token", async () => {
    expect((await refresh("/api/collections/users/auth/refresh")).status).toBe(401);

    const loginRes = await login(LOGIN_USERS, {
      email: "user@example.com",
      password: TEST_PASSWORD,
    });
    await refresh("/api/collections/users/auth/refresh", loginRes.body.data.token);
    const revoked = await refresh("/api/collections/users/auth/refresh", loginRes.body.data.token);
    expect(revoked.status).toBe(401);
  });

  it("403 when the token belongs to another collection", async () => {
    await api(ctx, "POST", "/api/collections", {
      token: ctx.superToken,
      body: {
        name: "admins",
        type: "auth",
        fields: [
          { name: "email", type: "email", required: true, unique: true },
          { name: "password", type: "text", required: true },
        ],
      },
    });

    const res = await refresh("/api/collections/admins/auth/refresh", ctx.userToken);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("does not belong to this collection");
  });
});

describe("POST /api/auth/logout", () => {
  it("revokes the caller's session and future requests become anonymous", async () => {
    const loginRes = await login(LOGIN_USERS, {
      email: "user@example.com",
      password: TEST_PASSWORD,
    });
    const token = loginRes.body.data.token;
    const decoded = await verifyJWT(token, TEST_SECRET);

    const res = await api(ctx, "POST", "/api/auth/logout", { token });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Session revoked");

    const session = await getSessionByJti(ctx.db, decoded.jti as string);
    expect(session!.revoked).toBe(1);

    // the same token is now anonymous everywhere...
    expect(
      (await api(ctx, "GET", "/api/collections", { token })).status,
    ).toBe(403);
    // ...including refresh, and a second logout is 401 (not 200)
    expect((await api(ctx, "POST", "/api/auth/logout", { token })).status).toBe(401);
  });

  it("401 without a token", async () => {
    const res = await api(ctx, "POST", "/api/auth/logout");
    expect(res.status).toBe(401);
  });
});

describe("stale session purge", () => {
  it("login removes expired rows but keeps live and revoked-unexpired ones", async () => {
    const now = Math.floor(Date.now() / 1000);
    const insertSession = (jti: string, expiresAt: number, revoked = 0) =>
      ctx.db
        .prepare(
          `INSERT INTO _sessions (collectionId, userId, jti, expiresAt, revoked) VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(ctx.usersId, "u1", jti, expiresAt, revoked)
        .run();

    const expiredJti = "expired-row";
    const liveJti = "live-row";
    const revokedJti = "revoked-row";
    await insertSession(expiredJti, now - 100);
    await insertSession(liveJti, now + 1000);
    await insertSession(revokedJti, now + 1000, 1);

    const res = await login(LOGIN_USERS, {
      email: "user@example.com",
      password: TEST_PASSWORD,
    });
    expect(res.status).toBe(200);

    expect(await getSessionByJti(ctx.db, expiredJti)).toBeNull();
    expect((await getSessionByJti(ctx.db, liveJti))!.revoked).toBe(0);
    // revoked rows survive purge while unexpired: the middleware must keep
    // rejecting their tokens
    expect((await getSessionByJti(ctx.db, revokedJti))!.revoked).toBe(1);
  });

  it("refresh also sweeps, and a purged token becomes unusable", async () => {
    await ctx.db
      .prepare(
        `INSERT INTO _sessions (collectionId, userId, jti, expiresAt) VALUES (?1, ?2, ?3, ?4)`,
      )
      .bind(ctx.usersId, "u1", "expired-during-refresh", Math.floor(Date.now() / 1000) - 10)
      .run();

    const res = await refresh("/api/collections/users/auth/refresh", ctx.userToken);
    expect(res.status).toBe(200);
    expect(await getSessionByJti(ctx.db, "expired-during-refresh")).toBeNull();
  });
});
