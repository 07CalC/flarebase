import { Hono } from "hono";
import { HonoApp } from "./config";
import { authMiddleware } from "./middleware/auth";
import { AppError } from "./error";

const app = new Hono<HonoApp>();

app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: err.message, data: null }, err.statusCode)
  }
  return c.json({
    error: "Internal Server Error",
    data: null,
  }, 500)
})

app.use('*', authMiddleware);

export default app;
