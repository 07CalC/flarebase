import { AppError, ResponseCode } from "./response";

export function mapD1Error(error: unknown): never {
  if (error instanceof AppError) {
    throw error;
  }

  const message =
    error instanceof Error ? error.message : String(error);

  if (/UNIQUE constraint failed/i.test(message)) {
    throw new AppError(
      "A record with these values already exists",
      409,
      ResponseCode.CONFLICT,
    );
  }

  if (/FOREIGN KEY constraint failed/i.test(message)) {
    throw new AppError(
      "The operation conflicts with related records",
      409,
      ResponseCode.CONFLICT,
    );
  }

  if (/NOT NULL constraint failed/i.test(message)) {
    throw new AppError(
      "A required field is missing",
      400,
      ResponseCode.VALIDATION_ERROR,
    );
  }

  if (/CHECK constraint failed/i.test(message)) {
    throw new AppError(
      "The provided data violates a constraint",
      400,
      ResponseCode.VALIDATION_ERROR,
    );
  }

  if (/datatype mismatch/i.test(message)) {
    throw new AppError(
      "The provided data has an invalid type",
      400,
      ResponseCode.VALIDATION_ERROR,
    );
  }

  if (/database is locked|database is busy|temporarily unavailable/i.test(message)) {
    throw new AppError(
      "The database is temporarily unavailable",
      503,
      ResponseCode.SERVICE_UNAVAILABLE,
    );
  }

  if (
    /no such table|no such column|syntax error|has no column named/i.test(
      message,
    )
  ) {
    throw new AppError(
      "A database operation failed",
      500,
      ResponseCode.DATABASE_ERROR,
    );
  }

  if (/table .*?already exists|view .*?already exists/i.test(message)) {
    throw new AppError(
      "A database operation failed",
      500,
      ResponseCode.INTERNAL_SERVER_ERROR,
    );
  }

  throw new AppError(
    "A database operation failed",
    500,
    ResponseCode.DATABASE_ERROR,
  );
}
