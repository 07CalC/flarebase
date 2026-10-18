import { Hono } from "hono";
import { HonoApp } from "../config";
import { error, ResponseCode, success } from "../lib/response";
import * as sessionService from "../services/session.service";

export const sessionRouter = new Hono<HonoApp>();

// not a part of auth api because it doesn't require collection context, but it does require auth middleware
sessionRouter.post("/logout", async (c) => {
  const auth = c.get("auth");
  if (!auth) {
    return error(c, "Missing or invalid token", 401, ResponseCode.UNAUTHORIZED);
  }

  await sessionService.revokeSession(c.env.DB, auth.sessionId);
  return success(c, "Session revoked", null, 200, ResponseCode.SUCCESS);
});
