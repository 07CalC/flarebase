import { describe, expect, it } from "bun:test";
import {
  DEFAULT_ITERATIONS,
  hashPassword,
  verifyPassword,
} from "../src/lib/hash";

const LOW_ITERATIONS = 2_000;

describe("hashPassword / verifyPassword", () => {
  it("roundtrips a password", async () => {
    const hash = await hashPassword("correct horse battery staple", LOW_ITERATIONS);
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("correct password", LOW_ITERATIONS);
    expect(await verifyPassword(hash, "incorrect password")).toBe(false);
  });

  it("roundtrips unicode passwords", async () => {
    const hash = await hashPassword("på§swörd✓你password", LOW_ITERATIONS);
    expect(await verifyPassword(hash, "på§swörd✓你password")).toBe(true);
    expect(await verifyPassword(hash, "pasword")).toBe(false);
  });

  it("uses the default iteration count when omitted", async () => {
    const hash = await hashPassword("some-password");
    const iterations = Number(hash.split("$")[1]);
    expect(iterations).toBe(DEFAULT_ITERATIONS);
    expect(await verifyPassword(hash, "some-password")).toBe(true);
  });

  it("records the supplied iteration count in the hash", async () => {
    const hash = await hashPassword("some-password", 12345);
    expect(hash.split("$")[1]).toBe("12345");
    expect(await verifyPassword(hash, "some-password")).toBe(true);
  });

  it("produces a fresh salt per call (same password, different hashes)", async () => {
    const a = await hashPassword("same-password", LOW_ITERATIONS);
    const b = await hashPassword("same-password", LOW_ITERATIONS);
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, "same-password")).toBe(true);
    expect(await verifyPassword(b, "same-password")).toBe(true);
    const [aSalt, bSalt] = [a.split("$")[2], b.split("$")[2]];
    expect(aSalt).not.toBe(bSalt);
  });

  it("delivers the documented format: pbkdf2$<iterations>$<salt-b64>$<key-b64>", async () => {
    const hash = await hashPassword("some-password", LOW_ITERATIONS);
    expect(hash.startsWith("pbkdf2$")).toBe(true);
    expect(hash.split("$")).toHaveLength(4);
  });
});

describe("verifyPassword rejects malformed / legacy hashes without throwing", () => {
  const cases: { name: string; hash: string }[] = [
    { name: "plain string", hash: "hashed-password" },
    { name: "legacy bare sha-256 digest", hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
    { name: "empty string", hash: "" },
    { name: "too few parts", hash: "pbkdf2$100000$c2FsdA==" },
    { name: "too many parts", hash: "pbkdf2$100000$c2FsdA==$a2V5$extra" },
    { name: "unknown algorithm prefix", hash: "argon2$100000$c2FsdA==$a2V5" },
    { name: "non-integer iterations", hash: "pbkdf2$abc$c2FsdA==$a2V5" },
    { name: "zero iterations", hash: "pbkdf2$0$c2FsdA==$a2V5" },
    { name: "below the iteration floor", hash: "pbkdf2$999$c2FsdA==$a2V5" },
    { name: "absurd iteration cost", hash: `pbkdf2$${Number.MAX_SAFE_INTEGER}$c2FsdA==$a2V5` },
    { name: "invalid base64 salt", hash: "pbkdf2$100000$!!!$a2V5" },
    { name: "invalid base64 key", hash: "pbkdf2$100000$c2FsdA==$%%%" },
    { name: "short salt", hash: "pbkdf2$100000$c2Fs$dw==" }, // 4 bytes
    { name: "wrong key length", hash: "pbkdf2$100000$c2FsdA==$YQ==" }, // 1 byte
  ];

  for (const c of cases) {
    it(`${c.name} -> false`, async () => {
      expect(await verifyPassword(c.hash, "any-password")).toBe(false);
    });
  }
});

describe("verifyPassword rejects tampered hashes", () => {
  it("key byte flipped -> false", async () => {
    const hash = await hashPassword("real password", LOW_ITERATIONS);
    const tampered = flipEncodedChar(hash, 3);
    expect(tampered).not.toBe(hash);
    expect(await verifyPassword(tampered, "real password")).toBe(false);
  });

  it("salt replaced with a different one -> false", async () => {
    const other = await hashPassword("other password", LOW_ITERATIONS);
    const [otherSalt] = other.split("$").slice(2, 3);
    const hash = await hashPassword("real password", LOW_ITERATIONS);
    const tampered = [hash.split("$")[0], hash.split("$")[1], otherSalt, hash.split("$")[3]].join("$");
    expect(await verifyPassword(tampered, "real password")).toBe(false);
  });

  it("key of another password -> false", async () => {
    const a = await hashPassword("password-a", LOW_ITERATIONS);
    const b = await hashPassword("password-b", 123_456);
    const stolen = [a.split("$")[0], a.split("$")[1], a.split("$")[2], b.split("$")[3]].join("$");
    expect(await verifyPassword(stolen, "password-a")).toBe(false);
    expect(await verifyPassword(stolen, "password-b")).toBe(false);
  });
});

function flipEncodedChar(hash: string, offset: number): string {
  const bytes = [...hash];
  const target = bytes.length - 1 - offset; // flip inside the key segment
  bytes[target] = bytes[target] === "A" ? "B" : "A";
  return bytes.join("");
}
