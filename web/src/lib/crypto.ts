/**
 * ECDH P-256 密钥协商 + AES-256-GCM 对称加密。
 * 优先使用浏览器 Web Crypto；普通局域网 HTTP 下自动降级到纯 JavaScript 实现。
 */

const ECDH_PARAMS: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' };

type NobleP256 = typeof import('@noble/curves/nist.js')['p256'];
type NobleGcm = typeof import('@noble/ciphers/aes.js')['gcm'];

function base64Encode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
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

interface NativeBackend {
  kind: 'native';
  subtle: SubtleCrypto;
  keyPair: CryptoKeyPair;
  aesKey: CryptoKey | null;
}

interface NobleBackend {
  kind: 'noble';
  p256: NobleP256;
  gcm: NobleGcm;
  secretKey: Uint8Array;
  aesKey: Uint8Array | null;
}

type CryptoBackend = NativeBackend | NobleBackend;

export interface CryptoClientOptions {
  /** 仅用于互操作测试；生产环境会在 Web Crypto 不可用时自动降级。 */
  forceFallback?: boolean;
}

function getCryptoApi(): Crypto {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
    throw new Error('当前浏览器缺少安全随机数生成器，无法建立加密会话');
  }
  return cryptoApi;
}

export class CryptoClient {
  private backend: CryptoBackend | null = null;
  private readonly options: CryptoClientOptions;

  constructor(options: CryptoClientOptions = {}) {
    this.options = options;
  }

  async generateKeyPair(): Promise<string> {
    const cryptoApi = getCryptoApi();
    const subtle = this.options.forceFallback ? undefined : cryptoApi.subtle;

    if (subtle) {
      const keyPair = await subtle.generateKey(ECDH_PARAMS, false, ['deriveKey']);
      const pubRaw = await subtle.exportKey('raw', keyPair.publicKey);
      this.backend = { kind: 'native', subtle, keyPair, aesKey: null };
      return base64Encode(pubRaw);
    }

    const [{ p256 }, { gcm }] = await Promise.all([
      import('@noble/curves/nist.js'),
      import('@noble/ciphers/aes.js'),
    ]);
    const { secretKey } = p256.keygen();
    // Web Crypto 的 P-256 raw 公钥是 SEC1 未压缩格式：0x04 + X + Y，共 65 字节。
    const publicKey = p256.getPublicKey(secretKey, false);
    this.backend = { kind: 'noble', p256, gcm, secretKey, aesKey: null };
    return base64Encode(publicKey);
  }

  async deriveKey(serverPublicKeyBase64: string): Promise<void> {
    const backend = this.backend;
    if (!backend) throw new Error('请先调用 generateKeyPair()');
    const peerPubRaw = base64Decode(serverPublicKeyBase64);

    if (backend.kind === 'native') {
      const peerPub = await backend.subtle.importKey('raw', peerPubRaw, ECDH_PARAMS, false, []);
      backend.aesKey = await backend.subtle.deriveKey(
        { name: 'ECDH', public: peerPub },
        backend.keyPair.privateKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
      return;
    }

    // noble 默认返回 33 字节压缩共享点。Web Crypto ECDH 派生出的 256 位
    // AES key 对应共享点的 X 坐标，即去掉首字节奇偶标记后的 32 字节。
    const sharedPoint = backend.p256.getSharedSecret(backend.secretKey, new Uint8Array(peerPubRaw));
    if (sharedPoint.length !== 33) {
      sharedPoint.fill(0);
      throw new Error(`ECDH 共享密钥长度异常: ${sharedPoint.length}`);
    }
    backend.aesKey = sharedPoint.slice(1);
    sharedPoint.fill(0);
  }

  get ready(): boolean {
    return this.backend !== null && this.backend.aesKey !== null;
  }

  async encrypt(plaintext: string): Promise<EncryptedPayload> {
    const backend = this.backend;
    if (!backend || !backend.aesKey) throw new Error('密钥尚未派生');
    const iv = getCryptoApi().getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext =
      backend.kind === 'native'
        ? await backend.subtle.encrypt({ name: 'AES-GCM', iv }, backend.aesKey, encoded)
        : backend.gcm(backend.aesKey, iv).encrypt(encoded);
    return {
      iv: base64Encode(iv),
      data: base64Encode(ciphertext),
    };
  }

  async decrypt(payload: EncryptedPayload): Promise<string> {
    const backend = this.backend;
    if (!backend || !backend.aesKey) throw new Error('密钥尚未派生');
    const iv = new Uint8Array(base64Decode(payload.iv));
    const ciphertext = base64Decode(payload.data);
    const decrypted =
      backend.kind === 'native'
        ? await backend.subtle.decrypt({ name: 'AES-GCM', iv }, backend.aesKey, ciphertext)
        : backend.gcm(backend.aesKey, iv).decrypt(new Uint8Array(ciphertext));
    return new TextDecoder().decode(decrypted);
  }

  dispose(): void {
    if (this.backend?.kind === 'noble') {
      this.backend.secretKey.fill(0);
      this.backend.aesKey?.fill(0);
    }
    this.backend = null;
  }
}
