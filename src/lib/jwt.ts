import { sign, verify } from "hono/jwt";


export type JwtPayload = {
  sub: string;
  email?: string;
  collectionId?: string;
  isSuperUser?: boolean;
  [key: string]: unknown;
}

export async function generateJWT(payload: JwtPayload, secret: string): Promise<string> {
  //TODO: should be configurable
  const exp = Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 7);
  return sign({
    ...payload,
    exp
  }, secret, "HS256");
}

export async function verifyJWT(token: string, secret: string): Promise<JwtPayload> {
  const decoded = await verify(token, secret, "HS256");
  return decoded as JwtPayload;
}



