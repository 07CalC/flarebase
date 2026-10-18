import { Context } from "hono";
import { HonoApp } from "../config";
import { AppError, ResponseCode } from "./response";

export async function readJsonBody(c: Context<HonoApp>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError("Invalid JSON body", 400, ResponseCode.INVALID_REQUEST);
  }
}
