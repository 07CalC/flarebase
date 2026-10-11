import { ContentfulStatusCode } from "hono/utils/http-status";
import { HonoApp } from "../config";
import { Context } from "hono";
import { ErrorCode } from "../error";

export const success = <T>(c: Context<HonoApp>, data: T, statusCode: ContentfulStatusCode, code: ErrorCode) => {
  return c.json({ data, error: null, code: code }, statusCode);
}

export const error = (c: Context<HonoApp>, error: string, statusCode: ContentfulStatusCode, code: string) => {
  return c.json({ data: null, error, code: ErrorCode }, statusCode);
}
