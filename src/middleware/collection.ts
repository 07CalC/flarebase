import { Context, MiddlewareHandler, Next } from "hono";
import { HonoApp } from "../config";
import { error, ResponseCode } from "../lib/response";
import * as collectionService from "../services/collection.service";

export const collectionMiddleware: MiddlewareHandler<HonoApp> = async (c: Context<HonoApp>, next: Next) => {
  const collectionName = c.req.param("collectionName");
  if (!collectionName) {
    return error(c, "Collection name is required", 400, ResponseCode.INVALID_REQUEST);
  }
  const collectionRecord = await collectionService.getCollectionByName(c.env.DB, collectionName);
  if (!collectionRecord) {
    return error(c, "Collection not found", 404, ResponseCode.NOT_FOUND);
  }
  c.set("collectionContext", collectionRecord);
  await next();
}
