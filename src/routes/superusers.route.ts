import { Hono } from "hono";
import { HonoApp } from "../config";
import * as collectionService from "../services/collection.service"
import * as recordService from "../services/records.service"
import { AppError, error, success, ResponseCode } from "../lib/response";
import { SUPERUSERS_COLLECTION, sanitizeAuthRecord } from "../lib/auth";
import { formatZodIssues } from "../lib/collection";
import { buildRecordCreateSchema } from "../lib/record-schema";
import { readJsonBody } from "../lib/request";
import { hashPassword } from "../lib/hash";

export const superuserRouter = new Hono<HonoApp>();

superuserRouter.post("/records", async (c) => {
  const collectionRecord = await collectionService.getAuthCollectionByName(c.env.DB, SUPERUSERS_COLLECTION);
  if (!collectionRecord) {
    return error(c, "Superusers collection is missing", 500, ResponseCode.DATABASE_ERROR);
  }

  const body = await readJsonBody(c);

  const parsed = buildRecordCreateSchema(collectionRecord.fields).safeParse(body);
  if (!parsed.success) {
    return error(c, formatZodIssues(parsed.error), 400, ResponseCode.VALIDATION_ERROR);
  }
  const recordData = parsed.data as Record<string, any>;
  if (recordData.password !== undefined) {
    recordData.password = await hashPassword(recordData.password);
  }
  const authContext = c.get("auth");

  // superusers can always create new superusers, but the first superuser can be created by anyone
  if (authContext?.isSuperUser) {
    const created = await recordService.createRecord(c.env.DB, collectionRecord, recordData);
    if (!created) {
      return error(c, "Failed to create superuser", 500, ResponseCode.INTERNAL_SERVER_ERROR);
    }
    return success(c, "Superuser created", sanitizeAuthRecord(created, collectionRecord.fields), 201, ResponseCode.CREATED);
  }

  const created = await recordService.createRecordOnlyIfEmpty(c.env.DB, collectionRecord, recordData);
  if (!created) {
    return error(c, "Only superusers can create superusers", 403, ResponseCode.FORBIDDEN);
  }
  return success(c, "Superuser created", sanitizeAuthRecord(created, collectionRecord.fields), 201, ResponseCode.CREATED);
})

