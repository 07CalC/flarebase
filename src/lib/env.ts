import { AppError, ResponseCode } from "./response";
import {
  DEFAULT_SESSION_TTL_SECONDS,
  MAX_SESSION_TTL_SECONDS,
  MIN_SESSION_TTL_SECONDS,
} from "./jwt";

// Workers have no startup hook, so "fail fast" happens at the first use of
// each value: a clear misconfigured error beats a cryptic crypto failure.
export function requireJwtSecret(env: { JWT_SECRET?: string | undefined }): string {
  const secret = env.JWT_SECRET;
  if (typeof secret !== "string" || secret.trim().length === 0) {
    throw new AppError(
      "Server misconfigured: JWT_SECRET is not set",
      500,
      ResponseCode.INTERNAL_SERVER_ERROR,
    );
  }
  return secret;
}

export function resolveSessionTtlSeconds(
  env: { SESSION_TTL_SECONDS?: string | undefined },
): number {
  const raw = env.SESSION_TTL_SECONDS;
  if (raw === undefined || raw === null || raw.trim() === "") {
    return DEFAULT_SESSION_TTL_SECONDS;
  }

  const seconds = Number(raw);
  if (!Number.isInteger(seconds)) {
    throw new AppError(
      "Server misconfigured: SESSION_TTL_SECONDS must be an integer number of seconds",
      500,
      ResponseCode.INTERNAL_SERVER_ERROR,
    );
  }
  if (seconds < MIN_SESSION_TTL_SECONDS || seconds > MAX_SESSION_TTL_SECONDS) {
    throw new AppError(
      `Server misconfigured: SESSION_TTL_SECONDS must be between ${MIN_SESSION_TTL_SECONDS} and ${MAX_SESSION_TTL_SECONDS} seconds`,
      500,
      ResponseCode.INTERNAL_SERVER_ERROR,
    );
  }
  return seconds;
}
