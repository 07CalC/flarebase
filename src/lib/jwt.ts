import { sign, verify } from "hono/jwt";


export type JwtPayload = {
  sub: string;
  collectionId?: string;
  jti?: string;
  isSuperUser?: boolean;
  [key: string]: unknown;
}

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export function newJti(): string {
  return crypto.randomUUID();
}

export async function generateJWT(payload: JwtPayload, secret: string): Promise<{ token: string; jti: string; exp: number }> {
  //TODO: should be configurable
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const jti = typeof payload.jti === 'string' && payload.jti.length > 0 ? payload.jti : newJti();
  const token = await sign({
    ...payload,
    jti,
    exp
  }, secret, "HS256");
  return { token, jti, exp };
}

export async function verifyJWT(token: string, secret: string): Promise<JwtPayload> {
  const decoded = await verify(token, secret, "HS256");
  return decoded as JwtPayload;
}



