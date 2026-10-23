import { beforeEach, describe, expect, it } from "vitest";
import { verifyPassword } from "../src/lib/hash";
import { api, setupTest, superApi, type TestContext } from "./setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupTest();
});

const BASE = "/api/collections/_superusers/records";
const LOGIN = "/api/collections/_superusers/auth/with-password";

async function storedHash(id = "su1"): Promise<string> {
  const row = (await ctx.db
    .prepare(`SELECT password FROM _superusers WHERE id = ?1`)
    .bind(id)
    .first()) as { password: string } | null;
  if (!row) throw new Error(`superuser ${id} not found`);
  return row.password;
}

async function superuserCount(): Promise<number> {
  const row = (await ctx.db
    .prepare(`SELECT COUNT(*) AS c FROM _superusers`)
    .first()) as { c: number };
  return row.c;
}

async function createSecondSuperuser(
  email = "second@example.com",
): Promise<string> {
  const res = await superApi(ctx, "POST", BASE, {
    body: { email, password: "second-password" },
  });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

describe("_superusers through the records API", () => {
  it("lists and reads records without leaking password hashes", async () => {
    const list = await superApi(ctx, "GET", BASE);
    expect(list.status).toBe(200);
    expect(list.body.data.totalItems).toBe(1);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0].email).toBe("admin@example.com");
    expect(list.body.data.items[0]).not.toHaveProperty("password");
    expect(JSON.stringify(list.body)).not.toContain("pbkdf2$");

    const get = await superApi(ctx, "GET", `${BASE}/su1`);
    expect(get.status).toBe(200);
    expect(get.body.data.email).toBe("admin@example.com");
    expect(get.body.data).not.toHaveProperty("password");
    expect(JSON.stringify(get.body)).not.toContain("pbkdf2$");
  });

  it("locks out anonymous and non-superuser callers (null rules)", async () => {
    const cases = [
      { method: "GET", path: BASE },
      { method: "GET", path: `${BASE}/su1` },
      {
        method: "PATCH",
        path: `${BASE}/su1`,
        body: { email: "attacker@example.com" },
      },
      {
        method: "PATCH",
        path: `${BASE}/su1`,
        body: { password: "attacker-password" },
      },
      { method: "DELETE", path: `${BASE}/su1` },
      {
        method: "POST",
        path: BASE,
        body: {
          email: "attacker@example.com",
          password: "attacker-password",
        },
      },
    ];

    for (const token of [null, ctx.userToken]) {
      for (const entry of cases) {
        const res = await api(ctx, entry.method, entry.path, {
          token,
          body: entry.body,
        });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("FORBIDDEN");
      }
    }

    // nothing changed
    const get = await superApi(ctx, "GET", `${BASE}/su1`);
    expect(get.body.data.email).toBe("admin@example.com");
    expect(await verifyPassword(await storedHash(), "hashed-password")).toBe(
      true,
    );
  });

  it("updates email and password; the password is rehashed and never returned", async () => {
    const before = await storedHash();
    const res = await superApi(ctx, "PATCH", `${BASE}/su1`, {
      body: {
        email: "root@example.com",
        password: "brand-new-password",
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe("root@example.com");
    expect(res.body.data).not.toHaveProperty("password");
    expect(JSON.stringify(res.body)).not.toContain("pbkdf2$");

    const after = await storedHash();
    expect(after).not.toBe(before);
    expect(after.startsWith("pbkdf2$")).toBe(true);
    expect(await verifyPassword(after, "brand-new-password")).toBe(true);
    expect(await verifyPassword(after, "hashed-password")).toBe(false);
  });

  it("authenticates with the updated password, not the old one", async () => {
    const patch = await superApi(ctx, "PATCH", `${BASE}/su1`, {
      body: { password: "brand-new-password" },
    });
    expect(patch.status).toBe(200);

    const oldLogin = await api(ctx, "POST", LOGIN, {
      body: { email: "admin@example.com", password: "hashed-password" },
    });
    expect(oldLogin.status).toBe(401);
    expect(oldLogin.body.code).toBe("UNAUTHORIZED");

    const newLogin = await api(ctx, "POST", LOGIN, {
      body: { email: "admin@example.com", password: "brand-new-password" },
    });
    expect(newLogin.status).toBe(200);
    expect(typeof newLogin.body.data.token).toBe("string");
    expect(newLogin.body.data.user.email).toBe("admin@example.com");
    expect(newLogin.body.data.user).not.toHaveProperty("password");
    expect(JSON.stringify(newLogin.body)).not.toContain("pbkdf2$");
  });

  it("validates password updates and leaves the stored hash untouched", async () => {
    const before = await storedHash();
    const res = await superApi(ctx, "PATCH", `${BASE}/su1`, {
      body: { password: "short" },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.error).toContain("at least 8");
    expect(await storedHash()).toBe(before);
  });

  it("maps duplicate emails to 409 conflicts", async () => {
    await createSecondSuperuser();

    const patch = await superApi(ctx, "PATCH", `${BASE}/su1`, {
      body: { email: "second@example.com" },
    });
    expect(patch.status).toBe(409);
    expect(patch.body.code).toBe("CONFLICT");

    const create = await superApi(ctx, "POST", BASE, {
      body: { email: "second@example.com", password: "third-password" },
    });
    expect(create.status).toBe(409);
    expect(create.body.code).toBe("CONFLICT");
  });

  it("refuses to delete the last superuser and keeps bootstrap closed", async () => {
    const res = await superApi(ctx, "DELETE", `${BASE}/su1`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONFLICT");
    expect(res.body.error).toBe("Cannot delete the last superuser");
    expect(await superuserCount()).toBe(1);

    // an empty table would reopen anonymous bootstrap, so this is a security
    // invariant, not just a lockout guard
    const bootstrap = await api(ctx, "POST", BASE, {
      body: { email: "takeover@example.com", password: "takeover-password" },
    });
    expect(bootstrap.status).toBe(403);
    expect(await superuserCount()).toBe(1);
  });

  it("allows deleting a superuser while another remains", async () => {
    const secondId = await createSecondSuperuser();

    const deleted = await superApi(ctx, "DELETE", `${BASE}/${secondId}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.id).toBe(secondId);
    expect(deleted.body.data).not.toHaveProperty("password");
    expect(JSON.stringify(deleted.body)).not.toContain("pbkdf2$");
    expect(await superuserCount()).toBe(1);

    const last = await superApi(ctx, "DELETE", `${BASE}/su1`);
    expect(last.status).toBe(409);
    expect(await superuserCount()).toBe(1);
  });

  it("returns 404 for unknown ids instead of the last-superuser conflict", async () => {
    const res = await superApi(ctx, "DELETE", `${BASE}/does-not-exist`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
    expect(await superuserCount()).toBe(1);
  });

  it("cannot be emptied by concurrent deletes", async () => {
    const secondId = await createSecondSuperuser();

    const [first, second] = await Promise.all([
      superApi(ctx, "DELETE", `${BASE}/su1`),
      superApi(ctx, "DELETE", `${BASE}/${secondId}`),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(await superuserCount()).toBe(1);
  });
});
