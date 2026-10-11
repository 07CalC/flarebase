import { ContentfulStatusCode } from "hono/utils/http-status";

export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: ContentfulStatusCode = 500,
    public code: string = "INTERNAL_SERVER_ERROR"
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const ErrorCode = {
  INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
  TIMEOUT: "TIMEOUT",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  UPSTREAM_ERROR: "UPSTREAM_ERROR",

  INVALID_REQUEST: "INVALID_REQUEST",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",

  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",

  DATABASE_ERROR: "DATABASE_ERROR",
  MIGRATION_ERROR: "MIGRATION_ERROR",
} as const;

export type ErrorCode =
  (typeof ErrorCode)[keyof typeof ErrorCode];
