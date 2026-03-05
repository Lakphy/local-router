/**
 * ECDH P-256 密钥协商 + AES-256-GCM 对称加密（浏览器 Web Crypto API）。
 */

const ECDH_PARAMS: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' };

function base64Encode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64Decode(str: string): ArrayBuffer {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export interface EncryptedPayload {
  iv: string;
  data: string;
}

export class CryptoClient {
  private keyPair: CryptoKeyPair | null = null;
  private aesKey: CryptoKey | null = null;

  async generateKeyPair(): Promise<string> {
    this.keyPair = await crypto.subtle.generateKey(ECDH_PARAMS, false, ['deriveKey']);
    const pubRaw = await crypto.subtle.exportKey('raw', this.keyPair.publicKey);
    return base64Encode(pubRaw);
  }

  async deriveKey(serverPublicKeyBase64: string): Promise<void> {
    if (!this.keyPair) throw new Error('请先调用 generateKeyPair()');
    const peerPubRaw = base64Decode(serverPublicKeyBase64);
    const peerPub = await crypto.subtle.importKey('raw', peerPubRaw, ECDH_PARAMS, false, []);
    this.aesKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: peerPub },
      this.keyPair.privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  get ready(): boolean {
    return this.aesKey !== null;
  }

  async encrypt(plaintext: string): Promise<EncryptedPayload> {
    if (!this.aesKey) throw new Error('密钥尚未派生');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.aesKey,
      encoded
    );
    return {
      iv: base64Encode(iv.buffer),
      data: base64Encode(ciphertext),
    };
  }

  async decrypt(payload: EncryptedPayload): Promise<string> {
    if (!this.aesKey) throw new Error('密钥尚未派生');
    const iv = new Uint8Array(base64Decode(payload.iv));
    const ciphertext = base64Decode(payload.data);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this.aesKey,
      ciphertext
    );
    return new TextDecoder().decode(decrypted);
  }
}
