// ===================================
// CRYPTO UTILITIES
// Based on battle-tested AES-GCM per-chunk encryption
// ===================================

/**
 * Encrypt a chunk using AES-GCM with random nonce
 * @param buffer - Raw chunk data
 * @param keyStr - Encryption key string
 * @param aad - Additional Authenticated Data (fileId:chunkIndex)
 * @returns Base64 encoded: nonce(12B) + ciphertext + auth_tag(16B)
 */
export async function encryptChunk(
  buffer: ArrayBuffer,
  keyStr: string,
  aad?: string,
): Promise<string> {
  // Derive key from string
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyStr.padEnd(32, "0").slice(0, 32)),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );

  // Generate random 12-byte nonce (CRITICAL: never reuse)
  const nonce = crypto.getRandomValues(new Uint8Array(12));

  // Prepare AAD if provided (prevents chunk swapping attacks)
  const aadBytes = aad ? new TextEncoder().encode(aad) : undefined;

  // Encrypt with AES-GCM (includes auth tag automatically)
  const aesParams: AesGcmParams = {
    name: "AES-GCM",
    iv: nonce,
  };
  if (aadBytes) {
    aesParams.additionalData = aadBytes;
  }

  const encrypted = await crypto.subtle.encrypt(aesParams, key, buffer);

  // Combine: nonce + ciphertext (includes 16-byte auth tag)
  const result = new Uint8Array(nonce.length + encrypted.byteLength);
  result.set(nonce, 0);
  result.set(new Uint8Array(encrypted), nonce.length);

  return arrayBufferToBase64(result);
}

/**
 * Decrypt a chunk using AES-GCM
 * @param base64 - Encrypted chunk (nonce + ciphertext + tag)
 * @param keyStr - Encryption key string
 * @param aad - Additional Authenticated Data (must match encryption)
 * @returns Decrypted ArrayBuffer
 */
export async function decryptChunk(
  base64: string,
  keyStr: string,
  aad?: string,
): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(base64ToArrayBuffer(base64));

  // Extract nonce and ciphertext
  const nonce = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);

  // Derive same key
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyStr.padEnd(32, "0").slice(0, 32)),
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  // Prepare AAD if provided
  const aadBytes = aad ? new TextEncoder().encode(aad) : undefined;

  try {
    // Decrypt and verify auth tag
    const aesParams: AesGcmParams = {
      name: "AES-GCM",
      iv: nonce,
    };
    if (aadBytes) {
      aesParams.additionalData = aadBytes;
    }

    return await crypto.subtle.decrypt(aesParams, key, ciphertext);
  } catch (error) {
    throw new Error("Decryption failed - chunk corrupted or tampered");
  }
}

/**
 * Encrypt text message
 */
export async function encryptText(
  text: string,
  keyStr: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  return encryptChunk(data.buffer, keyStr);
}

/**
 * Decrypt text message
 */
export async function decryptText(
  base64: string,
  keyStr: string,
): Promise<string> {
  const decrypted = await decryptChunk(base64, keyStr);
  return new TextDecoder().decode(decrypted);
}

/**
 * Calculate SHA-256 hash of file
 * Used for integrity verification
 */
export async function calculateFileSHA256(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Calculate SHA-256 hash of assembled chunks
 */
export async function calculateChunksSHA256(
  chunks: ArrayBuffer[],
): Promise<string> {
  const blob = new Blob(chunks);
  const buffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ===================================
// ENCODING UTILITIES
// ===================================

export function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  const len = bytes.byteLength;

  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);

  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return bytes.buffer as ArrayBuffer;
}

// ===================================
// ECDH KEY EXCHANGE
// ===================================

export async function generateECDHKeyPair(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(
    {
      name: "ECDH",
      namedCurve: "P-256",
    },
    true, // extractable
    ["deriveKey"],
  );
}

export async function exportPublicKey(publicKey: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey("raw", publicKey);
  return arrayBufferToBase64(exported);
}

export async function importPublicKey(base64: string): Promise<CryptoKey> {
  const buffer = base64ToArrayBuffer(base64);
  return await crypto.subtle.importKey(
    "raw",
    buffer,
    {
      name: "ECDH",
      namedCurve: "P-256",
    },
    false,
    [],
  );
}

export async function deriveSharedSecret(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
): Promise<CryptoKey> {
  return await crypto.subtle.deriveKey(
    {
      name: "ECDH",
      public: peerPublicKey,
    },
    privateKey,
    {
      name: "AES-GCM",
      length: 256,
    },
    true, // extractable for our use
    ["encrypt", "decrypt"],
  );
}

// Convert CryptoKey to string for use in encryption functions
export async function exportAESKey(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey("raw", key);
  return arrayBufferToBase64(exported);
}
