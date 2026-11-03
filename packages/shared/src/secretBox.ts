// Sealing JSON at rest with AES-256-GCM (WebCrypto: Bun and browsers have it, no dependency). A sealed value is a small JSON object, so it can sit in a jsonb column next
// to plain rows written before sealing was switched on. The key is 32 random bytes as base64; losing it loses what it sealed.

export interface Sealed {
  enc: "aes-gcm-v1";
  iv: string;
  ct: string;
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const isSealed = (x: unknown): x is Sealed => !!x && typeof x === "object" && (x as Sealed).enc === "aes-gcm-v1" && typeof (x as Sealed).iv === "string" && typeof (x as Sealed).ct === "string";

/** A fresh key, base64. */
export const newKey = () => b64(crypto.getRandomValues(new Uint8Array(32)));

async function importKey(key: string) {
  const raw = unb64(key.trim());
  if (raw.length !== 32) throw new Error("the sealing key must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(value: unknown, key: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // a new nonce per value: never reused with one key
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(key), new TextEncoder().encode(JSON.stringify(value))));
  return { enc: "aes-gcm-v1", iv: b64(iv), ct: b64(ct) };
}

/** Throws when the key is wrong or the value was changed (GCM checks both). */
export async function unseal<T = unknown>(s: Sealed, key: string): Promise<T> {
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv) as BufferSource }, await importKey(key), unb64(s.ct) as BufferSource);
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    throw new Error("could not unseal the stored data: wrong key, or the data was changed");
  }
}
