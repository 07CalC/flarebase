import { Hono } from "hono";
import { HonoApp } from "../config";
import { collectionMiddleware } from "../middleware/collection";
import { z } from "zod";
import { error, ResponseCode, success } from "../lib/response";
import { formatZodIssues } from "../lib/collection";
import { readJsonBody } from "../lib/request";
import { requireJwtSecret, resolveSessionTtlSeconds } from "../lib/env";
import * as recordService from "../services/records.service";
import * as sessionService from "../services/session.service";
import { equalizeLoginTiming, verifyPassword } from "../lib/hash";
import { generateJWT } from "../lib/jwt";
import { isSuperusersCollection, sanitizeAuthRecord } from "../lib/auth";

export const authRouter = new Hono<HonoApp>();

authRouter.use("/*", collectionMiddleware);

authRouter.post("/with-password", async (c) => {
  const collectionRecord = c.get("collectionContext");
  if (collectionRecord?.type !== "auth") {
    return error(c, "Collection is not an auth collection", 400, ResponseCode.INVALID_REQUEST);
  }

  const schema = z.object({
    email: z.email(),
    password: z.string(),
  });

  const body = await readJsonBody(c);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return error(c, formatZodIssues(parsed.error), 400, ResponseCode.VALIDATION_ERROR);
  }

  const { email, password } = parsed.data;

  const record = await recordService.getRecordByField(c.env.DB, collectionRecord, "email", email);
  if (!record) {
    // to prevent timing based user enumeration
    await equalizeLoginTiming(password);
    return error(c, "Invalid email or password", 401, ResponseCode.UNAUTHORIZED);
  }

  const isPasswordValid = await verifyPassword(record.password as string, password);
  if (!isPasswordValid) {
    return error(c, "Invalid email or password", 401, ResponseCode.UNAUTHORIZED);
  }

  const secret = requireJwtSecret(c.env);
  const ttlSeconds = resolveSessionTtlSeconds(c.env);
  const { token, jti, exp } = await generateJWT(
    {
      sub: record.id as string,
      collectionId: collectionRecord.id,
      collectionName: collectionRecord.name,
      isSuperUser: isSuperusersCollection(collectionRecord.name),
    },
    secret,
    { ttlSeconds },
  );


  await sessionService.createSession(c.env.DB, {
    collectionId: collectionRecord.id,
    userId: record.id as string,
    jti,
    expiresAt: exp,
    ip: c.req.header("cf-connecting-ip") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
  });

  // remove expired sessions in the backgroud, this is opportunistic and cannot (should not) fail the request
  c.executionCtx.waitUntil(sessionService.purgeExpiredSessions(c.env.DB));

  return success(
    c,
    "Authentication successful",
    { token, user: sanitizeAuthRecord(record, collectionRecord.fields) },
    200,
    ResponseCode.SUCCESS,
  );
});

authRouter.post("/refresh", async (c) => {
  const auth = c.get("auth");
  if (!auth) {
    return error(c, "Missing or invalid token", 401, ResponseCode.UNAUTHORIZED);
  }

  const collectionRecord = c.get("collectionContext");
  if (!collectionRecord || auth.collectionId !== collectionRecord.id) {
    return error(c, "Session does not belong to this collection", 403, ResponseCode.FORBIDDEN);
  }

  await sessionService.purgeExpiredSessions(c.env.DB);

  const secret = requireJwtSecret(c.env);
  const ttlSeconds = resolveSessionTtlSeconds(c.env);
  const { token, jti, exp } = await generateJWT(
    {
      sub: auth.id,
      collectionId: auth.collectionId,
      collectionName: auth.collectionName,
      isSuperUser: auth.isSuperUser,
    },
    secret,
    { ttlSeconds },
  );

  await sessionService.createSession(c.env.DB, {
    collectionId: auth.collectionId,
    userId: auth.id,
    jti,
    expiresAt: exp,
    ip: c.req.header("cf-connecting-ip") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
  });

  await sessionService.revokeSession(c.env.DB, auth.sessionId);

  const freshRecord = await recordService.getRecordById(c.env.DB, collectionRecord, auth.id, {
    includeHiddenFields: true,
  });
  if (!freshRecord) {
    return error(c, "Session user no longer exists", 401, ResponseCode.UNAUTHORIZED);
  }

  return success(
    c,
    "Session refreshed",
    { token, user: sanitizeAuthRecord(freshRecord, collectionRecord.fields) },
    200,
    ResponseCode.SUCCESS,
  );
});
