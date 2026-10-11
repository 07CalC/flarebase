import { Hono } from "hono";
import { HonoApp } from "./config";
import { authMiddleware } from "./middleware/auth";
import { authRouter } from "./modules/auth/auth.routes";
import { AppError, ResponseCode } from "./utils/response";

const app = new Hono<HonoApp>();

app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ message: err.message, data: null, error: err.message, code: err.code }, err.statusCode)
  }
  return c.json({
    message: "Internal Server Error",
    data: null,
    error: "Internal Server Error",
    code: ResponseCode.INTERNAL_SERVER_ERROR,
  }, 500)
})

app.use('*', authMiddleware);
app.route('/api/auth', authRouter);

export default app;
