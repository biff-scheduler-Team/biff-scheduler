const encoder = new TextEncoder();
export function randomToken() {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}
export function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );
}
export async function hash(value: string): Promise<string> {
  return encode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
async function key(secret: string) {
  if (secret.length < 32) throw new Error("Missing session encryption key");
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", encoder.encode(secret)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
export async function seal(value: unknown, secret: string, purpose: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(purpose) },
    await key(secret),
    encoder.encode(JSON.stringify(value)),
  );
  return `${encode(iv)}.${encode(new Uint8Array(body))}`;
}
export async function unseal(value: string, secret: string, purpose: string): Promise<unknown> {
  const [iv, body] = value.split(".");
  if (!iv || !body) throw new Error("Invalid encrypted session");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decode(iv), additionalData: encoder.encode(purpose) },
    await key(secret),
    decode(body),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}
