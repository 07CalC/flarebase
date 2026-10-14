import { Hono } from "hono";
import { HonoApp } from "./config";
import { authMiddleware } from "./middleware/auth";
import { AppError, ResponseCode } from "./lib/response";

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

app.get('/api/health', (c) => {
  return c.json({ message: 'ok', data: { status: 'ok' }, error: null, code: ResponseCode.SUCCESS }, 200);
});

app.use('*', authMiddleware);

app.notFound((c) => {
  return c.json({ message: null, data: null, error: 'Not Found', code: ResponseCode.NOT_FOUND }, 404);
});

export default app;
