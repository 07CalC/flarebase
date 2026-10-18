import { beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { HonoApp } from "../src/config";
import { authMiddleware } from "../src/middleware/auth";
import { generateJWT } from "../src/lib/jwt";
import { createSession } from "../src/services/session.service";
import { createCollection } from "../src/services/collection.service";
import { setupTest, TEST_SECRET, type TestContext } from "./setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupTest();
});

// minimal probe route mounting the app-wide auth middleware, exposes what
// routes would see as c.get("auth")
function buildProbeApp(): Hono<HonoApp> {
  const probe = new Hono<HonoApp>();
  probe.use("*", authMiddleware);
  probe.get("/", (c) => c.json({ auth: c.get("auth") }));
  return probe;
}

async function callProbe(
  probe: Hono<HonoApp>,
  token?: string,
): Promise<{ auth: any }> {
  const env = { DB: ctx.db, JWT_SECRET: TEST_SECRET } as unknown as CloudflareBindings;
  const res = await probe.request(
    "/",
    {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    },
    env,
  );
  return res.json();
}

describe("auth middleware context", () => {
  it("populates the full sanitized _superusers row for a superuser token", async () => {
    const body = await callProbe(buildProbeApp(), ctx.superToken);
    const auth = body.auth;
    expect(auth).not.toBeNull();
    expect(auth.id).toBe("su1");
    expect(auth.isSuperUser).toBe(true);
    expect(auth.collectionId).toBe("_superusers");
    expect(auth.collectionName).toBe("_superusers");
    expect(typeof auth.sessionId).toBe("string");
    expect(auth.sessionId.length).toBeGreaterThan(0);
    expect(auth.user.id).toBe("su1");
    expect(auth.user.email).toBe("admin@example.com");
    // full row: row columns are present...
    expect(auth.user.createdAt).toBeDefined();
    expect(auth.user.updatedAt).toBeDefined();
    // ...but sensitive ones are not
    expect(auth.user).not.toHaveProperty("password");
  });

  it("carries the full user row while stripping password and hidden fields", async () => {
    const admins = await createCollection(ctx.db, {
      name: "admins",
      type: "auth",
      fields: [
        { name: "email", type: "email", required: true, unique: true },
        { name: "password", type: "text", required: true },
        { name: "secret", type: "text", hidden: true },
        { name: "role", type: "text" },
        // adjacent name must survive: only exact-password names are stripped
        { name: "passwordHint", type: "text" },
      ],
    });
    await ctx.db
      .prepare(
        `INSERT INTO "admins" (id, email, password, secret, role, passwordHint)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind("a1", "ops@example.com", "hashed-password", "s3cret", "root", "hint")
      .run();

    const token = await generateJWT(
      { sub: "a1", collectionId: admins.id },
      TEST_SECRET,
    );
    await createSession(ctx.db, {
      collectionId: admins.id,
      userId: "a1",
      jti: token.jti,
      expiresAt: token.exp,
    });

    const body = await callProbe(buildProbeApp(), token.token);
    const auth = body.auth;

    expect(auth).not.toBeNull();
    expect(auth.isSuperUser).toBe(false);
    expect(auth.collectionId).toBe(admins.id);
    expect(auth.collectionName).toBe("admins");
    expect(auth.sessionId).toBe(token.jti);
    expect(auth.user.id).toBe("a1");
    // visible, non-sensitive row fields survive
    expect(auth.user.email).toBe("ops@example.com");
    expect(auth.user.role).toBe("root");
    expect(auth.user.passwordHint).toBe("hint");
    expect(auth.user.createdAt).toBeDefined();
    expect(auth.user.updatedAt).toBeDefined();
    // password is never exposed, hidden fields are not exposed
    expect(auth.user).not.toHaveProperty("password");
    expect(auth.user).not.toHaveProperty("secret");
  });

  it("sets null context when there is no token", async () => {
    const body = await callProbe(buildProbeApp());
    expect(body.auth).toBeNull();
  });

  it("sets null context for a garbage token", async () => {
    const body = await callProbe(buildProbeApp(), "not-a-real-token");
    expect(body.auth).toBeNull();
  });
});
