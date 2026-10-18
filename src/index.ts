import { Hono } from "hono";
import { HonoApp } from "./config";
import { recordsRouter } from "./routes/records.route";
import { AppError, ResponseCode } from "./lib/response";
import { collectionRouter } from "./routes/collection.route";
import { authMiddleware } from "./middleware/auth";

const app = new Hono<HonoApp>();

// auth middleware doesn't denies unauthenticated reqursts, it just adds the auth context to the request if the user is authenticated
// since api rules for each route can be different, routes will handle the authorization 
// themeselves
app.use("*", authMiddleware);

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

app.route('/api/collections', collectionRouter);
app.route('/api/collections/:collectionId', recordsRouter);

app.notFound((c) => {
  return c.json({ message: null, data: null, error: 'Not Found', code: ResponseCode.NOT_FOUND }, 404);
});

export default app;
