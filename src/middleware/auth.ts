import { Context, MiddlewareHandler, Next } from "hono";
import { HonoApp } from "../config";
import { error, ResponseCode } from "../lib/response";
import { verifyJWT } from "../lib/jwt";
import * as recordsService from "../services/records.service";
import * as collectionService from "../services/collection.service";
import * as sessionService from "../services/session.service";
import { isSuperusersCollection } from "../lib/auth";
import { isValidCollectionName } from "../lib/collection-name";

/**
 * Writes that the service layer gates itself (bootstrap / createRule /
 * login). The middleware lets them through without a token so the route
 * can decide; when a token IS present it is still validated.
 * No cookies: client stores the token and sends `Authorization: Bearer <token>`.
 */
function isPublicWrite(path: string, method: string): boolean {
  if (method !== "POST") return false;
  return /^\/api\/collections\/[^/]+\/(records|auth-with-password|auth-refresh)$/.test(path);
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

async function authenticate(c: Context<HonoApp>, token: string): Promise<{ ok: true } | { ok: false; response: Response }> {
  let decoded;
  try {
    decoded = await verifyJWT(token, c.env.JWT_SECRET);
  } catch (err) {
    if (err instanceof Error && err.name.startsWith("Jwt")) {
      return { ok: false, response: error(c, "Invalid token", 401, ResponseCode.UNAUTHORIZED) };
    }
    throw err;
  }

  const userId = decoded.sub;
  const collectionId = decoded.collectionId;
  const jti = decoded.jti;

  if (typeof userId !== "string" || userId.length === 0) {
    return { ok: false, response: error(c, "Invalid token", 401, ResponseCode.UNAUTHORIZED) };
  }
  if (typeof collectionId !== "string" || collectionId.length === 0) {
    return { ok: false, response: error(c, "Invalid token", 401, ResponseCode.UNAUTHORIZED) };
  }
  if (typeof jti !== "string" || jti.length === 0) {
    return { ok: false, response: error(c, "Invalid token", 401, ResponseCode.UNAUTHORIZED) };
  }

  const session = await sessionService.getSessionByJti(c.env.DB, jti);
  if (!session || !sessionService.isSessionActive(session)) {
    return { ok: false, response: error(c, "Invalid token", 401, ResponseCode.UNAUTHORIZED) };
  }
  if (session.userId !== userId || session.collectionId !== collectionId) {
    return { ok: false, response: error(c, "Invalid token", 401, ResponseCode.UNAUTHORIZED) };
  }

  const collectionRow = await collectionService.getCollectionById(c.env.DB, collectionId);
  if (!collectionRow || !isValidCollectionName(collectionRow.name) || collectionRow.type !== "auth") {
    return { ok: false, response: error(c, "Invalid token", 401, ResponseCode.UNAUTHORIZED) };
  }

  const user = await recordsService.getRecordById(c.env.DB, collectionRow, userId);
  if (!user) {
    return { ok: false, response: error(c, "Invalid token", 401, ResponseCode.UNAUTHORIZED) };
  }

  const isSuperUser = isSuperusersCollection(collectionRow.name);
  c.set("auth", {
    id: user.id as string,
    isSuperUser,
    collectionId: collectionRow.id,
    sessionId: jti,
  });
  return { ok: true };
}


export const authMiddleware: MiddlewareHandler<HonoApp> = async (c: Context<HonoApp>, next: Next) => {
  try {
    if (c.req.path === "/api/health") {
      return await next();
    }

    const token = extractBearerToken(c);

    if (!token) {
      if (isPublicWrite(c.req.path, c.req.method)) {
        return await next();
      }
      return error(c, "No token provided", 401, ResponseCode.UNAUTHORIZED);
    }

    const result = await authenticate(c, token);
    if (!result.ok) {
      return result.response;
    }
    return await next();
  } catch (err) {
    if (err instanceof Error && err.name.startsWith("Jwt")) {
      return error(c, "Invalid token", 401, ResponseCode.UNAUTHORIZED);
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
