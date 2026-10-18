import { describe, expect, it } from "bun:test";
import { requireJwtSecret, resolveSessionTtlSeconds } from "../src/lib/env";
import { AppError } from "../src/lib/response";
import {
  DEFAULT_SESSION_TTL_SECONDS,
  MAX_SESSION_TTL_SECONDS,
  MIN_SESSION_TTL_SECONDS,
} from "../src/lib/jwt";

function expectMisconfigured(fn: () => unknown) {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(AppError);
  const appError = caught as AppError;
  expect(appError.code).toBe("INTERNAL_SERVER_ERROR");
  expect(appError.statusCode).toBe(500);
  return appError;
}

describe("requireJwtSecret", () => {
  it("returns the configured secret", () => {
    expect(requireJwtSecret({ JWT_SECRET: "top-secret" })).toBe("top-secret");
  });

  it("fails clearly when the secret is missing / empty / blank", () => {
    for (const secret of [undefined, "", "   "] as (string | undefined)[]) {
      const err = expectMisconfigured(() => requireJwtSecret({ JWT_SECRET: secret }));
      expect(err.message).toContain("JWT_SECRET");
    }
  });
});

describe("resolveSessionTtlSeconds", () => {
  it("falls back to the default when unset or blank", () => {
    for (const raw of [undefined, "", "   "] as (string | undefined)[]) {
      expect(resolveSessionTtlSeconds({ SESSION_TTL_SECONDS: raw })).toBe(DEFAULT_SESSION_TTL_SECONDS);
    }
  });

  it("parses and trims a valid value", () => {
    expect(resolveSessionTtlSeconds({ SESSION_TTL_SECONDS: "3600" })).toBe(3600);
    expect(resolveSessionTtlSeconds({ SESSION_TTL_SECONDS: " 3600 " })).toBe(3600);
  });

  it("accepts the documented bounds inclusive", () => {
    expect(resolveSessionTtlSeconds({ SESSION_TTL_SECONDS: String(MIN_SESSION_TTL_SECONDS) }))
      .toBe(MIN_SESSION_TTL_SECONDS);
    expect(resolveSessionTtlSeconds({ SESSION_TTL_SECONDS: String(MAX_SESSION_TTL_SECONDS) }))
      .toBe(MAX_SESSION_TTL_SECONDS);
  });

  it("rejects values outside the bounds with a clear error", () => {
    for (const raw of ["0", "-5", "299", String(MAX_SESSION_TTL_SECONDS + 1)]) {
      const err = expectMisconfigured(() =>
        resolveSessionTtlSeconds({ SESSION_TTL_SECONDS: raw }),
      );
      expect(err.message).toContain("SESSION_TTL_SECONDS");
    }
  });

  it("rejects non-integer values", () => {
    for (const raw of ["abc", "1.5", "NaN", "Infinity", "1e10"]) {
      expectMisconfigured(() => resolveSessionTtlSeconds({ SESSION_TTL_SECONDS: raw }));
    }
  });
});
