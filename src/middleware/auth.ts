import { Context, MiddlewareHandler, Next } from "hono";
import { HonoApp } from "../config";
import { error, ResponseCode } from "../lib/response";
import { verifyJWT } from "../lib/jwt";
import * as recordsService from "../services/records.service";
import * as collectionService from "../services/collection.service";
import * as sessionService from "../services/session.service";
import { isSuperusersCollection } from "../lib/auth";
import { isValidCollectionName } from "../lib/collection-name";


export const authMiddleware: MiddlewareHandler<HonoApp> = async (c: Context<HonoApp>, next: Next) => {
  try {
    const token = extractBearerToken(c);

    if (!token) {
      c.set("auth", null);
      return await next();
    }

    const authenticated = await authenticate(c, token);
    if (!authenticated) {
      c.set("auth", null);
    }
    return await next();
  } catch (err) {
    if (err instanceof Error && err.name.startsWith("Jwt")) {
      c.set("auth", null);
      return await next();
    }
    return error(c, "Internal Server Error", 500, ResponseCode.INTERNAL_SERVER_ERROR);
  }
}

export const superUserRequired: MiddlewareHandler<HonoApp> = async (c: Context<HonoApp>, next: Next) => {
  const auth = c.get("auth");
  if (!auth || !auth.isSuperUser) {
    return error(c, "Superuser access required", 403, ResponseCode.FORBIDDEN);
  }
  await next();
}


async function authenticate(c: Context<HonoApp>, token: string): Promise<boolean> {
  let decoded;
  try {
    decoded = await verifyJWT(token, c.env.JWT_SECRET);
  } catch (err) {
    if (err instanceof Error && err.name.startsWith("Jwt")) {
      return false;
    }
    throw err;
  }

  const userId = decoded.sub;
  const collectionId = decoded.collectionId;
  const jti = decoded.jti;

  if (typeof userId !== "string" || userId.length === 0) {
    return false;
  }
  if (typeof collectionId !== "string" || collectionId.length === 0) {
    return false;
  }
  if (typeof jti !== "string" || jti.length === 0) {
    return false;
  }

  const session = await sessionService.getSessionByJti(c.env.DB, jti);
  if (!session || !sessionService.isSessionActive(session)) {
    return false;
  }
  if (session.userId !== userId || session.collectionId !== collectionId) {
    return false;
  }

  const collectionRow = await collectionService.getCollectionById(c.env.DB, collectionId);
  if (!collectionRow || !isValidCollectionName(collectionRow.name) || collectionRow.type !== "auth") {
    return false;
  }

  const user = await recordsService.getRecordById(c.env.DB, collectionRow, userId);
  if (!user) {
    return false;
  }

  const isSuperUser = isSuperusersCollection(collectionRow.name);
  c.set("auth", {
    id: user.id as string,
    isSuperUser,
    collectionId: collectionRow.id,
    sessionId: jti,
  });
  return true;
}



function extractBearerToken(c: Context<HonoApp>): string | undefined {
  const rawHeader = c.req.header("Authorization");
  if (!rawHeader) return undefined;
  const trimmed = rawHeader.trim();
  if (trimmed.length === 0) return undefined;
  if (/^bearer\s+/i.test(trimmed)) {
    const token = trimmed.replace(/^bearer\s+/i, "").trim();
    return token.length > 0 ? token : undefined;
  }
  return trimmed;
}

