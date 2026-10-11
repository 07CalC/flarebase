import { Context, MiddlewareHandler, Next } from "hono";
import { HonoApp } from "../config";
import { error, ResponseCode } from "../lib/response";
import { verifyJWT } from "../lib/jwt";
import { getCookie } from "hono/cookie";
import * as recordsService from "../services/records.service";
import * as collectionService from "../services/collection.service";

const PUBLIC_PATHS = ["/api/auth/signup", "/auth/signup", "/signup"];


export const authMiddleware: MiddlewareHandler<HonoApp> = async (c: Context<HonoApp>, next: Next) => {
  try {
    if (PUBLIC_PATHS.includes(c.req.path)) {
      return await next();
    }
    const rawHeader = c.req.header('Authorization');
    const cookieToken = getCookie(c, 'fb_token');
    const token = rawHeader?.startsWith('Bearer ')
      ? rawHeader.slice(7).trim()
      : rawHeader?.trim() || cookieToken;
    if (!token) {
      return error(c, 'No token provided', 401, ResponseCode.UNAUTHORIZED);
    }
    const decoded = await verifyJWT(token, c.env.JWT_SECRET);
    const userId = decoded.sub;
    const collectionId = decoded.collectionId;
    const isSuperUser = decoded.isSuperUser === true;

    if (typeof userId !== 'string' || userId.length === 0) {
      return error(c, 'Invalid token', 401, ResponseCode.UNAUTHORIZED);
    }

    if (isSuperUser) {
      const user = await recordsService.getRecordById(c.env.DB, '_superusers', userId);
      if (!user) {
        return error(c, 'Invalid token', 401, ResponseCode.UNAUTHORIZED);
      }
      c.set('auth', { id: user.id as string, email: user.email as string, isSuperUser: true });
      return await next()
    }

    if (typeof collectionId !== 'string' || collectionId.length === 0) {
      return error(c, 'Invalid token', 401, ResponseCode.UNAUTHORIZED);
    }


    const collectionRow = await collectionService.getAuthCollectionById(c.env.DB, collectionId);
    if (!collectionRow || typeof collectionRow.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(collectionRow.name)) {
      return error(c, 'Invalid token', 401, ResponseCode.UNAUTHORIZED);
    }

    // const user = await c.env.DB.prepare(`
    //   SELECT id FROM "${collectionRow.name}"
    //   WHERE id = ?1
    // `).bind(userId).first<{ id: string }>();
    //
    const user = await recordsService.getRecordById(c.env.DB, collectionRow.name, userId);

    if (!user) {
      return error(c, 'Invalid token', 401, ResponseCode.UNAUTHORIZED);
    }

    c.set('auth', { id: user.id as string, email: user.email, isSuperUser: false });

    return await next()
  } catch (err) {
    if (err instanceof Error && err.name.startsWith('Jwt')) {
      return error(c, 'Invalid token', 401, ResponseCode.UNAUTHORIZED);
    }
    return error(c, 'Internal Server Error', 500, ResponseCode.INTERNAL_SERVER_ERROR);
  }
}

export const superUserRequired: MiddlewareHandler<HonoApp> = async (c: Context<HonoApp>, next: Next) => {
  const auth = c.get('auth');
  if (!auth || !auth.isSuperUser) {
    return error(c, 'Superuser access required', 403, ResponseCode.FORBIDDEN);
  }
  await next();
}
