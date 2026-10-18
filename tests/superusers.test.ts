import { beforeEach, describe, expect, it } from "bun:test";
import { verifyPassword } from "../src/lib/hash";
import { generateJWT } from "../src/lib/jwt";
import { createSession } from "../src/services/session.service";
import { api, setupTest, superApi, TEST_SECRET, type TestContext } from "./setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupTest();
});

const START_URL = "/api/collections/_superusers/records";

// setupTest seeds exactly one superuser (su1); bootstrap tests run against an
// empty _superusers table to be inside the "initial setup" window
function clearSuperusers() {
  ctx.raw.exec(`DELETE FROM _superusers`);
}

describe("POST /api/collections/_superusers/records", () => {
  describe("bootstrap (no superusers exist)", () => {
    it("anyone can create the first superuser without auth", async () => {
      clearSuperusers();
      const res = await api(ctx, "POST", START_URL, {
        body: { email: "first@flarebase.dev", password: "supersecret1" },
      });
      expect(res.status).toBe(201);
      expect(res.body.code).toBe("CREATED");
      expect(res.body.data.email).toBe("first@flarebase.dev");
      expect(typeof res.body.data.id).toBe("string");
      expect(res.body.data.createdAt).toBeDefined();
      // the password hash must never leave the server
      expect(res.body.data).not.toHaveProperty("password");

      // stored under our salted scheme, and it verifies
      const row = ctx.raw
        .query(`SELECT password FROM _superusers WHERE email = 'first@flarebase.dev'`)
        .get() as { password: string } | null;
      expect(row).not.toBeNull();
      expect(row!.password.startsWith("pbkdf2$")).toBe(true);
      expect(await verifyPassword(row!.password, "supersecret1")).toBe(true);
      expect(await verifyPassword(row!.password, "not-the-password")).toBe(false);
    });

    it("an authenticated non-superuser can also bootstrap while the table is empty", async () => {
      clearSuperusers();
      const res = await api(ctx, "POST", START_URL, {
        token: ctx.userToken,
        body: { email: "first@flarebase.dev", password: "supersecret1" },
      });
      expect(res.status).toBe(201);
    });

    it("is refused once a superuser exists (no auth)", async () => {
      const res = await api(ctx, "POST", START_URL, {
        body: { email: "second@flarebase.dev", password: "supersecret2" },
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
      expect(res.body.error).toBe("Only superusers can create superusers");
      const count = (ctx.raw.query(`SELECT COUNT(*) as c FROM _superusers`).get() as any).c;
      expect(count).toBe(1);
    });

    it("an authed non-superuser is refused once a superuser exists", async () => {
      const res = await api(ctx, "POST", START_URL, {
        token: ctx.userToken,
        body: { email: "second@flarebase.dev", password: "supersecret2" },
      });
      expect(res.status).toBe(403);
    });
  });

  describe("management (superusers exist)", () => {
    async function loginAsFirstSuperuser(): Promise<string> {
      clearSuperusers();
      const first = await api(ctx, "POST", START_URL, {
        body: { email: "first@flarebase.dev", password: "supersecret1" },
      });
      expect(first.status).toBe(201);
      const firstId = first.body.data.id;
      const token = await generateJWT(
        { sub: firstId, collectionId: "_superusers", isSuperUser: true },
        TEST_SECRET,
      );
      await createSession(ctx.db, {
        collectionId: "_superusers",
        userId: firstId,
        jti: token.jti,
        expiresAt: token.exp,
      });
      return token.token;
    }

    it("superusers can create additional superusers", async () => {
      const token = await loginAsFirstSuperuser();
      const res = await api(ctx, "POST", START_URL, {
        token,
        body: { email: "second@flarebase.dev", password: "supersecret2" },
      });
      expect(res.status).toBe(201);
      expect(res.body.data).not.toHaveProperty("password");
      const count = (ctx.raw.query(`SELECT COUNT(*) as c FROM _superusers`).get() as any).c;
      expect(count).toBe(2);
    });

    it("rejects an invalid email with the shared issue format", async () => {
      const res = await superApi(ctx, "POST", START_URL, {
        body: { email: "not-an-email", password: "supersecret1" },
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.error).toContain("email");
    });

    it("rejects a too-short password (default min 8)", async () => {
      const res = await superApi(ctx, "POST", START_URL, {
        body: { email: "x@flarebase.dev", password: "short" },
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.error).toContain("at least 8");
    });

    it("honors options.minPasswordLength on the _superusers collection", async () => {
      const patched = await superApi(ctx, "PATCH", "/api/collections/_superusers", {
        body: { options: { minPasswordLength: 12 } },
      });
      expect(patched.status).toBe(200);

      const res = await superApi(ctx, "POST", START_URL, {
        body: { email: "x@flarebase.dev", password: "8_charsyy" }, // 9 < 12
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("at least 12");

      const ok = await superApi(ctx, "POST", START_URL, {
        body: { email: "y@flarebase.dev", password: "twelve_chars_x" },
      });
      expect(ok.status).toBe(201);
    });

    it("ignores extra request keys", async () => {
      const res = await superApi(ctx, "POST", START_URL, {
        body: { email: "x@flarebase.dev", password: "supersecret1", admin: true, password2: "x" },
      });
      expect(res.status).toBe(201);
      expect(res.body.data).not.toHaveProperty("admin");
      expect(res.body.data).not.toHaveProperty("password2");
      expect(res.body.data.email).toBe("x@flarebase.dev");
    });

    it("malformed JSON body -> 400 INVALID_REQUEST", async () => {
      const res = await superApi(ctx, "POST", START_URL, { rawBody: "not json" });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_REQUEST");
    });
  });
});
