import { Hono } from "hono";
import { HonoApp } from "./config";
import { authMiddleware } from "./middleware/auth";

const app = new Hono<HonoApp>();


app.use('*', authMiddleware);

export default app;
