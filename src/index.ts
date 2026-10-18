import { Hono } from "hono";
import { HonoApp } from "./config";
import { recordsRouter } from "./routes/records.route";
import { AppError, ResponseCode } from "./lib/response";
import { collectionRouter } from "./routes/collection.route";
import { superuserRouter } from "./routes/superusers.route";
import { authMiddleware } from "./middleware/auth";
import { authRouter } from "./routes/auth.route";
import { sessionRouter } from "./routes/session.route";

const app = new Hono<HonoApp>();

// auth middleware doesn't reject unauthenticated requests, it adds the auth
// context when the caller is authenticated; each route applies its own
// authorization (superuser requirement / api rules)
app.use("*", authMiddleware);

app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ message: err.message, data: null, error: err.message, code: err.code }, err.statusCode)
  }
  // never swallow unexpected errors: without this line a 500 is
  // undiagnosable (workers log to stderr / tail logs)
  console.error("unhandled error:", err);
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

// _superusers and records router MUST be mounted before the collections router: its
// literal mount wins first-match over collectionRouter's use("/*")
// superuser-required wildcard, keeping the first-superuser bootstrap open
// while normal collection management stays guarded
app.route('/api/auth', sessionRouter);
app.route('/api/collections/_superusers', superuserRouter);
app.route('/api/collections/:collectionName/records', recordsRouter);
app.route('/api/collections/:collectionName/auth', authRouter)
app.route('/api/collections', collectionRouter);

app.notFound((c) => {
  return c.json({ message: null, data: null, error: 'Not Found', code: ResponseCode.NOT_FOUND }, 404);
});

export default app;
