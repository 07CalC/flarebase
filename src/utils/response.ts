import { ContentfulStatusCode } from "hono/utils/http-status";
import { HonoApp } from "../config";
import { Context } from "hono";

export const success = <T>(c: Context<HonoApp>, data: T, code: ContentfulStatusCode) => {
  return c.json({ data, error: null }, code);
}

export const error = (c: Context<HonoApp>, error: string, code: ContentfulStatusCode) => {
  return c.json({ data: null, error }, code);
}
