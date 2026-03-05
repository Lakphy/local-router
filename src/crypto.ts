/**
 * ECDH P-256 密钥协商 + AES-256-GCM 对称加密。
 * 使用 Web Crypto API，Bun 原生支持。
 */

const ECDH_PARAMS: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' };

function base64Encode(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString('base64');
}

function base64Decode(str: string): ArrayBuffer {
  return Buffer.from(str, 'base64').buffer;
}

export interface EncryptedPayload {
  iv: string;
  data: string;
}

export class CryptoSession {
  private keyPair: CryptoKeyPair | null = null;
  private aesKey: CryptoKey | null = null;

  dispose(): void {
    this.keyPair = null;
    this.aesKey = null;
  }

  /** 生成 ECDH 密钥对，返回 base64 编码的公钥 */
  async init(): Promise<string> {
    this.keyPair = await crypto.subtle.generateKey(ECDH_PARAMS, false, ['deriveKey']);
    const pubRaw = await crypto.subtle.exportKey('raw', this.keyPair.publicKey);
    return base64Encode(pubRaw);
  }

  /** 用对方的公钥派生 AES-256-GCM 密钥 */
  async deriveKey(peerPublicKeyBase64: string): Promise<void> {
    if (!this.keyPair) throw new Error('请先调用 init()');
    const peerPubRaw = base64Decode(peerPublicKeyBase64);
    const peerPub = await crypto.subtle.importKey('raw', peerPubRaw, ECDH_PARAMS, false, []);
    this.aesKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: peerPub },
      this.keyPair.privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
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
