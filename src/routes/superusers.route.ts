import { Context, Hono } from "hono";
import { HonoApp } from "../config";
import * as collectionService from "../services/collection.service"
import * as recordService from "../services/records.service"
import { z } from "zod"
import { AppError, error, success, ResponseCode } from "../lib/response";
import { SUPERUSERS_COLLECTION, sanitizeAuthRecord } from "../lib/auth";
import { formatZodIssues } from "../lib/collection";
import { hashPassword, verifyPassword } from "../lib/hash";
import { generateJWT } from "../lib/jwt";

export const superuserRouter = new Hono<HonoApp>();

async function readJsonBody(c: Context<HonoApp>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError("Invalid JSON body", 400, ResponseCode.INVALID_REQUEST);
  }
}

superuserRouter.post("/records", async (c) => {
  // ARCHITECTURE: this endpoint manages the system `_superusers` collection,
  // everything about it is pinned there (not driven by a path param)
  const collectionRecord = await collectionService.getAuthCollectionByName(c.env.DB, SUPERUSERS_COLLECTION);
  if (!collectionRecord) {
    return error(c, "Superusers collection is missing", 500, ResponseCode.DATABASE_ERROR);
  }

  const body = await readJsonBody(c);
  const minPasswordLen = collectionRecord.options?.minPasswordLength || 8;
  const schema = z.object({
    email: z.email(),
    password: z.string().min(minPasswordLen, `Password must be at least ${minPasswordLen} characters long`),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return error(c, formatZodIssues(parsed.error), 400, ResponseCode.VALIDATION_ERROR);
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const authContext = c.get("auth");

  // ARCHITECTURE: superusers can always create superusers; anyone else only
  // while the system has none (initial setup)
  if (authContext?.isSuperUser) {
    const created = await recordService.createRecord(c.env.DB, collectionRecord, {
      email: parsed.data.email,
      password: passwordHash,
    });
    if (!created) {
      return error(c, "Failed to create superuser", 500, ResponseCode.INTERNAL_SERVER_ERROR);
    }
    // password hash must never leave the server
    return success(c, "Superuser created", sanitizeAuthRecord(created, collectionRecord.fields), 201, ResponseCode.CREATED);
  }

  // race-safe bootstrap: single guarded insert that only lands while the
  // table is empty, so two concurrent first signups cannot both succeed
  const created = await recordService.createRecordOnlyIfEmpty(c.env.DB, collectionRecord, {
    email: parsed.data.email,
    password: passwordHash,
  });
  if (!created) {
    return error(c, "Only superusers can create superusers", 403, ResponseCode.FORBIDDEN);
  }
  return success(c, "Superuser created", sanitizeAuthRecord(created, collectionRecord.fields), 201, ResponseCode.CREATED);
})

superuserRouter.post("/auth-with-password", async (c) => {
  const collectionName = c.req.param("collectionName");
  if (!collectionName || collectionName.trim() === "") {
    return error(c, "Collection ID or name is required", 400, "INVALID_REQUEST");
  }

  const collectionRecord = await collectionService.getCollectionByName(c.env.DB, collectionName);

  if (!collectionRecord) {
    return error(c, "Collection not found", 404, "NOT_FOUND");
  }

  const body = await c.req.json();
  const schema = z.object({
    email: z.string().email(),
    password: z.string(),
  });

  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return error(c, parsed.error.message, 400, "VALIDATION_ERROR");
  }

  const superuserRecord = await recordService.getRecordById(c.env.DB, collectionRecord, parsed.data.email, { includeHiddenFields: true });

  if (!superuserRecord) {
    return error(c, "Invalid email or password", 401, "UNAUTHORIZED");
  }

  const isPasswordValid = await verifyPassword(superuserRecord.password as string, parsed.data.password);

  if (!isPasswordValid) {
    return error(c, "Invalid email or password", 401, "UNAUTHORIZED");
  }

  const jwtToken = await generateJWT({
    sub: superuserRecord.id as string,
    collectionId: collectionRecord.id,
    isSuperUser: true,
  }, c.env.JWT_SECRET);

  return success(c, "Authentication successful", { email: superuserRecord.email }, 200, "SUCCESS");

})
