import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  setupTest,
  superApi,
  tableInfo,
  type TestContext,
} from "./setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupTest();
});

describe("_files system collection", () => {
  it("is seeded and visible in the collection list", async () => {
    const res = await superApi(ctx, "GET", "/api/collections");
    expect(res.status).toBe(200);
    const files = res.body.data.find((c: any) => c.name === "_files");
    expect(files).toBeDefined();
    expect(files.system).toBe(true);
    expect(files.type).toBe("base");
    expect(files.fields.map((f: any) => f.name)).toEqual([
      "collectionId",
      "recordId",
      "field",
      "filename",
      "size",
      "mime",
      "checksum",
      "storageKey",
    ]);
  });

  it("resolves through the collection detail endpoint", async () => {
    const res = await superApi(ctx, "GET", "/api/collections/_files");
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("_files");
    expect(res.body.data.system).toBe(true);
    expect(res.body.data.options).toEqual({});
    expect(res.body.data.indexes).toEqual([
      { name: "idx_files_record", on: ["collectionId", "recordId"] },
    ]);
    for (const rule of [
      "listRule",
      "viewRule",
      "createRule",
      "updateRule",
      "deleteRule",
    ]) {
      expect(res.body.data[rule]).toBeNull();
    }
  });

  it("has the expected metadata table columns", async () => {
    const columns = await tableInfo(ctx.db, "_files");
    expect(columns.map((c) => c.name)).toEqual([
      "id",
      "collectionId",
      "recordId",
      "field",
      "filename",
      "size",
      "mime",
      "checksum",
      "storageKey",
      "createdAt",
      "updatedAt",
    ]);
    const size = columns.find((c) => c.name === "size");
    expect(size?.type).toBe("INTEGER");
    expect(size?.notnull).toBe(1);
    expect(columns.find((c) => c.name === "checksum")?.notnull).toBe(0);
  });

  it("cannot have its metadata modified or deleted", async () => {
    const patch = await superApi(ctx, "PATCH", "/api/collections/_files", {
      body: { fields: [{ name: "x", type: "text" }] },
    });
    expect(patch.status).toBe(400);
    expect(patch.body.error).toContain(
      "System collection fields cannot be modified",
    );

    const del = await superApi(ctx, "DELETE", "/api/collections/_files");
    expect(del.status).toBe(400);
    expect((await superApi(ctx, "GET", "/api/collections/_files")).status).toBe(
      200,
    );
  });

  it("exposes the FILE_BUCKET R2 binding", async () => {
    const key = "tests/wiring.txt";
    await env.FILE_BUCKET.put(key, "flarebase");
    const object = await env.FILE_BUCKET.get(key);
    expect(object).not.toBeNull();
    expect(await object!.text()).toBe("flarebase");
    await env.FILE_BUCKET.delete(key);
  });
});
