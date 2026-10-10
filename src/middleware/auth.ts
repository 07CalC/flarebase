import { Context, MiddlewareHandler, Next } from "hono";
import { HonoApp } from "../config";


export const authMiddleware: MiddlewareHandler<HonoApp> = async (c: Context<HonoApp>, next: Next) => {
  const token = c.req.header('Authorization');
  if (!token) {

  }

}

