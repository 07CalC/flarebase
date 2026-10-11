import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { ZodError } from "zod";
import { HonoApp } from "../../config";
import * as authService from "./auth.service";
import { AppError, ResponseCode, success } from "../../utils/response";
import { generateJWT } from "../../utils/jwt";
import * as authSchema from "./auth.schema";

export const COOKIE_NAME = "fb_token";
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days, matches JWT exp

export const authRouter = new Hono<HonoApp>();

authRouter.post("/signup", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new AppError(
      "Invalid JSON body",
      400,
      ResponseCode.INVALID_REQUEST
    );
  }

  let parsed: { email: string; password: string };
  try {
    parsed = authSchema.signUpSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new AppError(
        err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        400,
        ResponseCode.VALIDATION_ERROR
      );
    }
    throw err;
  }

  const { email, password } = parsed;

  const superUserExists = await authService.doesSuperUserExist(c.env.DB);
  if (superUserExists) {
    throw new AppError(
      "A super user already exists. Sign up is disabled.",
      403,
      ResponseCode.FORBIDDEN
    );
  }

  const superUser = await authService.createSuperUser(c.env.DB, email, password);

  if (!c.env.JWT_SECRET) {
    throw new AppError(
      "Server misconfigured: JWT secret missing",
      500,
      ResponseCode.INTERNAL_SERVER_ERROR
    );
  }

  const token = await generateJWT(
    { sub: superUser.id, isSuperUser: true },
    c.env.JWT_SECRET
  );

  const isHttps = new URL(c.req.url).protocol === "https:";
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: "Lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });

  return success(
    c,
    "Super user created successfully",
    { user: superUser, token },
    201,
    ResponseCode.CREATED
  );
})
