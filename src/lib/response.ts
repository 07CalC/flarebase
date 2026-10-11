import { ContentfulStatusCode } from "hono/utils/http-status";
import { HonoApp } from "../config";
import { Context } from "hono";

export const ResponseCode = {
  // Success
  SUCCESS: "SUCCESS",
  CREATED: "CREATED",
  ACCEPTED: "ACCEPTED",
  NO_CONTENT: "NO_CONTENT",

  // Client errors
  INVALID_REQUEST: "INVALID_REQUEST",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  UNAUTHORIZED: "UNAUTHORIZED",
  INVALID_TOKEN: "INVALID_TOKEN",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",

  // Server errors
  INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  DATABASE_ERROR: "DATABASE_ERROR",
  MIGRATION_ERROR: "MIGRATION_ERROR",
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
  TIMEOUT: "TIMEOUT",
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
} as const;

export type ResponseCode =
  (typeof ResponseCode)[keyof typeof ResponseCode];

export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: ContentfulStatusCode = 500,
    public code: ResponseCode = ResponseCode.INTERNAL_SERVER_ERROR
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const success = <T>(c: Context<HonoApp>, message: string, data: T, statusCode: ContentfulStatusCode, code: ResponseCode) => {
  return c.json({ message: message, data, error: null, code: code }, statusCode);
}

export const error = (c: Context<HonoApp>, error: string, statusCode: ContentfulStatusCode, code: ResponseCode) => {
  return c.json({ message: null, data: null, error, code: code }, statusCode);
}
