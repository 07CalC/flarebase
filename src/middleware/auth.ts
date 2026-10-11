import { Context, MiddlewareHandler, Next } from "hono";
import { HonoApp } from "../config";
import { error } from "../utils/response";
import { verifyJWT } from "../utils/jwt";
import { ErrorCode } from "../error";


export const authMiddleware: MiddlewareHandler<HonoApp> = async (c: Context<HonoApp>, next: Next) => {
  try {
    const token = c.req.header('Authorization');
    if (!token) {
      return error(c, 'Unauthorized: No token provided', 401, ErrorCode.UNAUTHORIZED);
    }
    const decoded = await verifyJWT(token, c.env.JWT_SECRET);
    const userId = decoded.sub;
    const collectionId = decoded.collectionId;
    const isSuperUser = decoded.isSuperUser === true;

    if (typeof userId !== 'string' || userId.length === 0) {
      return error(c, 'Unauthorized: Invalid token', 401, ErrorCode.UNAUTHORIZED);
    }

    if (isSuperUser) {
      const user = await c.env.DB.prepare(`
        SELECT id FROM _superusers WHERE id = ?1
      `).bind(userId).first<{ id: string }>();
      if (!user) {
        return error(c, 'Unauthorized: Invalid token', 401, ErrorCode.UNAUTHORIZED);
      }
      c.set('auth', { id: user.id as string, isSuperUser: true });
      return await next()
    }

    if (typeof collectionId !== 'string' || collectionId.length === 0) {
      return error(c, 'Unauthorized: Invalid token', 401, ErrorCode.INVALID_TOKEN);
    }

    const collectionRow = await c.env.DB.prepare(`
      SELECT name FROM _collections WHERE id = ?1 AND type = 'auth'
    `).bind(collectionId).first<{ name: string }>();

    if (!collectionRow || typeof collectionRow.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(collectionRow.name)) {
      return error(c, 'Unauthorized: Invalid token', 401, ErrorCode.UNAUTHORIZED);
    }

    const user = await c.env.DB.prepare(`
      SELECT id FROM "${collectionRow.name}"
      WHERE id = ?1
    `).bind(userId).first<{ id: string }>();

    if (!user) {
      return error(c, 'Unauthorized: Invalid token', 401, ErrorCode.UNAUTHORIZED);
    }

    c.set('auth', { id: user.id as string, isSuperUser: false });

    return await next()
  } catch (err) {
    if (err instanceof Error && err.name.startsWith('Jwt')) {
      return error(c, 'Unauthorized: Invalid token', 401, ErrorCode.UNAUTHORIZED);
    }
    return error(c, 'Internal Server Error', 500, ErrorCode.INTERNAL_SERVER_ERROR);
  }
}

export const superUserRequired: MiddlewareHandler<HonoApp> = async (c: Context<HonoApp>, next: Next) => {
  const auth = c.get('auth');
  if (!auth || !auth.isSuperUser) {
    return error(c, 'Forbidden: Superuser access required', 403, ErrorCode.FORBIDDEN);
  }
  await next();
}
