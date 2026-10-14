/// /api/collections/:collectionName/records

import { Hono } from "hono";
import { HonoApp } from "../config";
import { error, ResponseCode } from "../lib/response";


export const recordsRouter = new Hono<HonoApp>();


recordsRouter.get('/', async (c) => {
  const collectionName = c.req.query('collectionName');
  if (!collectionName || typeof collectionName !== 'string') {
    return error(c, 'Missing or invalid collectionName', 400, ResponseCode.INVALID_REQUEST);
  }
})
