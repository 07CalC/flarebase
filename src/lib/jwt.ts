import { sign, verify } from "hono/jwt";

export type JwtPayload = {
  sub: string;
  collectionId?: string;
  jti?: string;
  isSuperUser?: boolean;
  [key: string]: unknown;
}

// TTL bounds are shared with lib/env.ts which validates the
// SESSION_TTL_SECONDS worker var (the resolved value is passed into
// generateJWT by its callers, e.g. the auth service)
export const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
export const MIN_SESSION_TTL_SECONDS = 300; // 5 minutes
export const MAX_SESSION_TTL_SECONDS = 2_592_000; // 30 days

export type GenerateJwtOptions = {
  ttlSeconds?: number;
  jti?: string;
};

export function newJti(): string {
  return crypto.randomUUID();
}

export async function generateJWT(
  payload: JwtPayload,
  secret: string,
  options: GenerateJwtOptions = {},
): Promise<{ token: string; jti: string; exp: number }> {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const jti = typeof options.jti === "string" && options.jti.length > 0 ? options.jti : newJti();
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
