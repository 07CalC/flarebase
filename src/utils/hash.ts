



export async function hashString(str: string): Promise<string> {
  const text = new TextEncoder().encode(str);
  const myDigest = await crypto.subtle.digest("SHA-256", text);
  const hashArray = Array.from(new Uint8Array(myDigest));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex;
}
