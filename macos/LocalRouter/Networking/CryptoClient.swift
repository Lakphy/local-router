import CryptoKit
import Foundation
import Security

enum CryptoError: LocalizedError {
    case noKeyPair
    case noSymmetricKey
    case invalidServerKey
    case encryptionFailed
    case decryptionFailed
    case invalidBase64
    case keyGenerationFailed
    case keyExchangeFailed

    var errorDescription: String? {
        switch self {
        case .noKeyPair: "密钥对尚未生成"
        case .noSymmetricKey: "对称密钥尚未派生"
        case .invalidServerKey: "无效的服务器公钥"
        case .encryptionFailed: "加密失败"
        case .decryptionFailed: "解密失败"
        case .invalidBase64: "无效的 Base64 编码"
        case .keyGenerationFailed: "密钥生成失败"
        case .keyExchangeFailed: "密钥交换失败"
        }
    }
}

final class CryptoClient: Sendable {
    private let secPrivateKey: SecKey
    private let publicKeyData: Data
    private nonisolated(unsafe) var _symmetricKey: SymmetricKey?

    init() {
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
        ]
        var error: Unmanaged<CFError>?
        guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
            fatalError("Failed to generate P-256 key pair: \(error!.takeRetainedValue())")
        }
        self.secPrivateKey = privateKey

        let pubKey = SecKeyCopyPublicKey(privateKey)!
        var exportError: Unmanaged<CFError>?
        guard let pubData = SecKeyCopyExternalRepresentation(pubKey, &exportError) as Data? else {
            fatalError("Failed to export public key: \(exportError!.takeRetainedValue())")
        }
        // SecKeyCopyExternalRepresentation for EC keys returns the uncompressed point (04 || x || y), 65 bytes
        self.publicKeyData = pubData
    }

    var publicKeyBase64: String {
        publicKeyData.base64EncodedString()
    }

    func deriveKey(serverPublicKeyBase64: String) throws {
        guard let serverKeyData = Data(base64Encoded: serverPublicKeyBase64) else {
            throw CryptoError.invalidBase64
        }

        // Import server's public key as SecKey
        let keyAttributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
            kSecAttrKeySizeInBits as String: 256,
        ]
        var importError: Unmanaged<CFError>?
        guard let serverPubKey = SecKeyCreateWithData(
            serverKeyData as CFData,
            keyAttributes as CFDictionary,
            &importError
        ) else {
            throw CryptoError.invalidServerKey
        }

        // Perform raw ECDH key exchange — returns the raw x-coordinate (32 bytes)
        // This matches Web Crypto's deriveBits/deriveKey behavior: no KDF applied
        let exchangeParams: [String: Any] = [:]
        var exchangeError: Unmanaged<CFError>?
        guard let sharedSecretData = SecKeyCopyKeyExchangeResult(
            secPrivateKey,
            .ecdhKeyExchangeStandard,
            serverPubKey,
            exchangeParams as CFDictionary,
            &exchangeError
        ) as Data? else {
            throw CryptoError.keyExchangeFailed
        }

        // Use raw shared secret bytes directly as AES-256 key (matching Web Crypto behavior)
        _symmetricKey = SymmetricKey(data: sharedSecretData)
    }

    func encrypt(_ plaintext: String) throws -> EncryptedPayload {
        guard let key = _symmetricKey else { throw CryptoError.noSymmetricKey }
        guard let data = plaintext.data(using: .utf8) else { throw CryptoError.encryptionFailed }

        let nonce = AES.GCM.Nonce()
        let sealed = try AES.GCM.seal(data, using: key, nonce: nonce)

        guard let combined = sealed.combined else { throw CryptoError.encryptionFailed }

        // combined = nonce (12) + ciphertext + tag (16)
        let ivData = Data(nonce)
        let ciphertextAndTag = combined.dropFirst(12)

        return EncryptedPayload(
            iv: ivData.base64EncodedString(),
            data: Data(ciphertextAndTag).base64EncodedString()
        )
    }

    func decrypt(_ payload: EncryptedPayload) throws -> String {
        guard let key = _symmetricKey else { throw CryptoError.noSymmetricKey }
        guard let ivData = Data(base64Encoded: payload.iv),
              let ciphertextAndTag = Data(base64Encoded: payload.data) else {
            throw CryptoError.invalidBase64
        }

        let sealedBox = try AES.GCM.SealedBox(combined: ivData + ciphertextAndTag)
        let decrypted = try AES.GCM.open(sealedBox, using: key)

        guard let result = String(data: decrypted, encoding: .utf8) else {
            throw CryptoError.decryptionFailed
        }
        return result
    }
}
