import { Hono } from "hono";
import { HonoApp } from "./config";

const app = new Hono<HonoApp>();

export default app;
