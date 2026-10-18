import { Context, Hono } from "hono";
import { HonoApp } from "../config";
import { superUserRequired } from "../middleware/auth";
import {
  AppError,
  error,
  ResponseCode,
  success,
} from "../lib/response";
import {
  createCollectionSchema,
  formatZodIssues,
  updateCollectionSchema,
} from "../lib/collection";
import * as collectionService from "../services/collection.service";

export const collectionRouter = new Hono<HonoApp>();

// authentication runs globally on the root app; this router only requires
// the caller to be a superuser for collection management
collectionRouter.use("/*", superUserRequired);

async function readJsonBody(c: Context<HonoApp>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError("Invalid JSON body", 400, ResponseCode.INVALID_REQUEST);
  }
}

collectionRouter.post("/", async (c) => {
  const body = await readJsonBody(c);
  const parsed = createCollectionSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(
      formatZodIssues(parsed.error),
      400,
      ResponseCode.VALIDATION_ERROR,
    );
  }
  const created = await collectionService.createCollection(c.env.DB, parsed.data);
  return success(c, "Collection created", created, 201, ResponseCode.CREATED);
});

collectionRouter.get("/", async (c) => {
  const collections = await collectionService.listCollections(c.env.DB);
  return success(c, "Collections retrieved", collections, 200, ResponseCode.SUCCESS);
});

collectionRouter.get("/:id", async (c) => {
  const collection = await collectionService.getCollectionByIdOrName(
    c.env.DB,
    c.req.param("id"),
  );
  if (!collection) {
    return error(c, "Collection not found", 404, ResponseCode.NOT_FOUND);
  }
  return success(c, "Collection retrieved", collection, 200, ResponseCode.SUCCESS);
});

collectionRouter.patch("/:id", async (c) => {
  const body = await readJsonBody(c);
  const parsed = updateCollectionSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(
      formatZodIssues(parsed.error),
      400,
      ResponseCode.VALIDATION_ERROR,
    );
  }
  const updated = await collectionService.updateCollectionById(
    c.env.DB,
    c.req.param("id"),
    parsed.data,
  );
  return success(c, "Collection updated", updated, 200, ResponseCode.SUCCESS);
});

collectionRouter.delete("/:id", async (c) => {
  const deleted = await collectionService.deleteCollectionById(
    c.env.DB,
    c.req.param("id"),
  );
  return success(c, "Collection deleted", deleted, 200, ResponseCode.SUCCESS);
});
