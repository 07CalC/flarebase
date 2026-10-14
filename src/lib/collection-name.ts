import { AppError, ResponseCode } from "./response";

const COLLECTION_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_NAME_LENGTH = 64;

export function isValidCollectionName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= MAX_NAME_LENGTH &&
    COLLECTION_NAME_RE.test(name)
  );
}

export function assertValidCollectionName(name: unknown): asserts name is string {
  if (!isValidCollectionName(name)) {
    throw new AppError(
      "Invalid collection name",
      400,
      ResponseCode.INVALID_REQUEST,
    );
  }
}

export function quoteIdent(name: string): string {
  assertValidCollectionName(name);
  return `"${name.replace(/"/g, '""')}"`;
}
