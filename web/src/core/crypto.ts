export async function encrypt(buf: ArrayBuffer, keyStr: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyStr.padEnd(16, "0").slice(0, 16)),
    "AES-GCM",
    false,
    ["encrypt"],
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buf);

  const out = new Uint8Array(iv.length + enc.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(enc), iv.length);

  return btoa(String.fromCharCode(...out));
}

export async function decrypt(b64: string, keyStr: string) {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const iv = raw.slice(0, 12);
  const data = raw.slice(12);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyStr.padEnd(16, "0").slice(0, 16)),
    "AES-GCM",
    false,
    ["decrypt"],
  );

  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
}
