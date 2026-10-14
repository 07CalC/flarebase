import { Hono } from "hono";
import { HonoApp } from "../config";
import { superUserRequired } from "../middleware/auth";

export const collectionRouter = new Hono<HonoApp>();

collectionRouter.use("/", superUserRequired);



