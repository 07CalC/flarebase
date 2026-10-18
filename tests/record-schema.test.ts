import { describe, expect, it } from "bun:test";
import {
  buildRecordCreateSchema,
  buildRecordUpdateSchema,
} from "../src/lib/record-schema";

const FIELDS = [
  { name: "email", type: "email", required: true, unique: true, max: 254 },
  { name: "password", type: "text", required: true, min: 8, max: 128 },
  { name: "role", type: "text", required: true },
  { name: "secret", type: "text", hidden: true },
  { name: "bio", type: "text", min: 2, max: 100, default: "hi" },
  { name: "age", type: "number", min: 0, max: 120 },
  { name: "active", type: "bool", required: true },
  { name: "meta", type: "json", required: true },
  { name: "website", type: "url" },
  { name: "birthdate", type: "date" },
  { name: "color", type: "select", values: ["red", "blue"] },
  { name: "owner", type: "relation", collectionId: "users" },
  { name: "avatar", type: "file" },
];

describe("buildRecordCreateSchema", () => {
  it("accepts a complete valid body", () => {
    const schema = buildRecordCreateSchema(FIELDS);
    const res = schema.safeParse({
      email: "user@flarebase.dev",
      password: "long-password",
      role: "admin",
      active: true,
      meta: { any: "json" },
      bio: "optional bio",
      age: 30,
      website: "https://flarebase.dev",
      birthdate: "1990-01-01",
      color: "red",
      owner: "u1",
      avatar: "photo.jpg",
    });
    expect(res.success).toBe(true);
  });

  it("requires flagged fields and reports the field path", () => {
    const schema = buildRecordCreateSchema(FIELDS);
    const res = schema.safeParse({ password: "long-password", active: true, meta: {} });
    expect(res.success).toBe(false);
    const paths = (res.error as any).issues.map((i: any) => i.path[0]);
    expect(paths).toContain("email");
  });

  it("requires json fields to actually be present (z.any sentinel)", () => {
    const schema = buildRecordCreateSchema(FIELDS);
    const res = schema.safeParse({
      email: "u@f.dev",
      password: "long-password",
      role: "x",
      active: true,
      // meta deliberately missing
    });
    expect(res.success).toBe(false);
    const issues = (res.error as any).issues;
    expect(issues.some((i: any) => i.path[0] === "meta")).toBe(true);
  });

  it("treats required fields with a default as optional", () => {
    const schema = buildRecordCreateSchema(FIELDS);
    const res = schema.safeParse({
      email: "u@f.dev",
      password: "long-password",
      role: "x",
      active: true,
      meta: {},
      // bio omitted, has default "hi"
    });
    if (!res.success) throw new Error("expected success");
    expect(res.data.bio).toBeUndefined(); // zod default not applied; column default covers it
  });

  it("enforces stored min/max on the password field", () => {
    const schema = buildRecordCreateSchema(FIELDS);
    expect(schema.safeParse({}).success).toBe(false);

    const short = schema.safeParse({
      email: "u@f.dev", role: "x", active: true, meta: {}, password: "short",
    });
    expect(short.success).toBe(false);
    expect((short.error as any).issues[0].message).toBe("Must be at least 8 characters");

    const long = schema.safeParse({
      email: "u@f.dev", role: "x", active: true, meta: {}, password: "p".repeat(129),
    });
    expect(long.success).toBe(false);
    expect((long.error as any).issues[0].message).toBe("Must be at most 128 characters");
  });

  it("enforces number ranges", () => {
    const schema = buildRecordCreateSchema(FIELDS);
    const res = schema.safeParse({
      email: "u@f.dev", role: "x", active: true, meta: {}, password: "long-password", age: 121,
    });
    // age is not required; a present value must still satisfy the bounds
    expect(res.success).toBe(false);
    expect((res.error as any).issues.some((i: any) => i.path.includes("age"))).toBe(true);
  });

  it("rejects non-numbers for number fields", () => {
    const schema = buildRecordCreateSchema(FIELDS);
    const res = schema.safeParse({
      email: "u@f.dev", role: "x", active: true, meta: {}, password: "long-password", age: "old",
    });
    expect(res.success).toBe(false);
    const issue = (res.error as any).issues.find((i: any) => i.path.includes("age"));
    expect(issue.message).toBe("Must be a number");
  });

  it("validates email/url formats", () => {
    const schema = buildRecordCreateSchema(FIELDS);
    for (const partial of [
      { email: "not-an-email", role: "x", active: true, meta: {}, password: "long-password" },
      { email: "u@f.dev", role: "x", active: true, meta: {}, password: "long-password", website: "not a url" },
    ]) {
      expect(schema.safeParse(partial).success).toBe(false);
    }
  });

  it("enforces select values", () => {
    const schema = buildRecordCreateSchema(FIELDS);
    const res = schema.safeParse({
      email: "u@f.dev", role: "x", active: true, meta: {}, password: "long-password", color: "green",
    });
    expect(res.success).toBe(false);
    expect((res.error as any).issues.some((i: any) => i.path.includes("color"))).toBe(true);
  });

  it("strips unknown keys", () => {
    const schema = buildRecordCreateSchema(FIELDS);
    const res = schema.safeParse({
      email: "u@f.dev", role: "x", active: true, meta: {}, password: "long-password", isAdmin: true,
    });
    if (!res.success) throw new Error("expected success");
    expect(res.data).not.toHaveProperty("isAdmin");
  });

  it("never accepts hidden fields as client input", () => {
    const schema = buildRecordCreateSchema(FIELDS);
    const res = schema.safeParse({
      email: "u@f.dev", role: "x", active: true, meta: {}, password: "long-password", secret: "tried",
    });
    if (!res.success) throw new Error("expected success");
    expect(res.data).not.toHaveProperty("secret");
  });
});

describe("buildRecordUpdateSchema", () => {
  it("makes every field optional but keeps constraints", () => {
    const schema = buildRecordUpdateSchema(FIELDS);
    // role is required on create; on patch a single optional field is enough
    const res = schema.safeParse({ bio: "updated bio" });
    if (!res.success) throw new Error("expected success");
    expect(res.data.role).toBeUndefined();

    const bad = schema.safeParse({ color: "green" });
    expect(bad.success).toBe(false);
  });

  it("rejects empty patches", () => {
    const res = buildRecordUpdateSchema(FIELDS).safeParse({});
    expect(res.success).toBe(false);
    expect((res.error as any).issues[0].message).toBe("At least one field is required");
  });

  it("still strips hidden and unknown keys", () => {
    const res = buildRecordUpdateSchema(FIELDS).safeParse({ secret: "s", nope: 1 });
    // both keys were dropped before the at-least-one check ran
    expect(res.success).toBe(false);
    const issues = (res.error as any).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe("At least one field is required");
  });
});
