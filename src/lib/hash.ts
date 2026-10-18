// workers native password hashing
//
// format: pbkdf2$<iterations>$<salt-b64>$<key-b64>
// salt is 16 random bytes, new per password

const ALGORITHM = "pbkdf2";
const DERIVE_HASH = "SHA-256";
const SALT_BYTES = 16;
const KEY_BITS = 256;

export const DEFAULT_ITERATIONS = 100_000;
const MIN_ITERATIONS = 1_000;
const MAX_ITERATIONS = 10_000_000;
const MIN_SALT_BYTES = 8;

interface ParsedHash {
  iterations: number;
  salt: Uint8Array;
  key: Uint8Array;
}

export async function hashPassword(
  password: string,
  iterations: number = DEFAULT_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKey(password, salt, iterations);
  return `${ALGORITHM}$${iterations}$${toBase64(salt)}$${toBase64(key)}`;
}

export async function verifyPassword(
  storedHash: string,
  password: string,
): Promise<boolean> {
  const parsed = parseHash(storedHash);
  if (!parsed) {
    return false;
  }
  const computed = await deriveKey(password, parsed.salt, parsed.iterations);
  return timingSafeEqual(computed, parsed.key);
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    ALGORITHM,
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: ALGORITHM, hash: DERIVE_HASH, salt, iterations },
    passwordKey,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

function parseHash(storedHash: string): ParsedHash | null {
  if (typeof storedHash !== "string" || storedHash.length === 0) {
    return null;
  }

  const parts = storedHash.split("$");
  if (parts.length !== 4) {
    return null;
  }
  const [algorithm, iterationsRaw, saltRaw, keyRaw] = parts;

  if (algorithm !== ALGORITHM) {
    return null;
  }

  const iterations = Number(iterationsRaw);
  if (
    !Number.isInteger(iterations) ||
    iterations < MIN_ITERATIONS ||
    iterations > MAX_ITERATIONS
  ) {
    return null;
  }

  let salt: Uint8Array;
  let key: Uint8Array;
  try {
    salt = fromBase64(saltRaw);
    key = fromBase64(keyRaw);
  } catch {
    return null;
  }
  // the stored digest must be exactly what our scheme produces; shorter or
  // longer keys indicate a foreign hash, not a failed password check
  if (salt.length < MIN_SALT_BYTES || key.length * 8 !== KEY_BITS) {
    return null;
  }

  return { iterations, salt, key };
}

// Byte-wise comparison over the max length of both inputs so a length
// mismatch still burns the same comparison work; the leading length check
// keeps the result correct.
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = i < a.length ? a[i] : 0;
    const bi = i < b.length ? b[i] : 0;
    diff |= ai ^ bi;
  }
  return diff === 0;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
