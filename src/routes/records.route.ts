import { Hono } from "hono";
import { HonoApp } from "../config";


export const recordsRouter = new Hono<HonoApp>();

recordsRouter.get("/", async (c) => {
  const collectionid = c.req.param("collectionName");
  return c.json({ message: collectionid })
})

