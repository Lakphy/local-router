import Foundation

enum OrderedJSONEncoder {
    static func encode<T: Encodable>(_ value: T, prettyPrinted: Bool = false) throws -> Data {
        let encoder = _OrderedEncoder()
        try value.encode(to: encoder)
        let json = encoder.root.toJSON(indent: prettyPrinted ? 0 : nil)
        guard let data = json.data(using: .utf8) else {
            throw EncodingError.invalidValue(value, .init(codingPath: [], debugDescription: "Failed to encode to UTF-8"))
        }
        return data
    }

    static func encodeToString<T: Encodable>(_ value: T, prettyPrinted: Bool = false) throws -> String {
        let data = try encode(value, prettyPrinted: prettyPrinted)
        return String(data: data, encoding: .utf8)!
    }
}

private indirect enum JSONNode {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONNode])
    case object([(key: String, value: JSONNode)])

    func toJSON(indent: Int?) -> String {
        switch self {
        case .null: return "null"
        case .bool(let v): return v ? "true" : "false"
        case .int(let v): return "\(v)"
        case .double(let v):
            if v.truncatingRemainder(dividingBy: 1) == 0 && abs(v) < 1e15 {
                return "\(Int(v))"
            }
            return "\(v)"
        case .string(let v): return escapeJSON(v)
        case .array(let items):
            if items.isEmpty { return "[]" }
            if let indent {
                let inner = indent + 1
                let pad = String(repeating: "  ", count: inner)
                let closing = String(repeating: "  ", count: indent)
                let entries = items.map { "\(pad)\($0.toJSON(indent: inner))" }
                return "[\n\(entries.joined(separator: ",\n"))\n\(closing)]"
            }
            return "[\(items.map { $0.toJSON(indent: nil) }.joined(separator: ","))]"
        case .object(let pairs):
            if pairs.isEmpty { return "{}" }
            if let indent {
                let inner = indent + 1
                let pad = String(repeating: "  ", count: inner)
                let closing = String(repeating: "  ", count: indent)
                let entries = pairs.map { "\(pad)\(escapeJSON($0.key)): \($0.value.toJSON(indent: inner))" }
                return "{\n\(entries.joined(separator: ",\n"))\n\(closing)}"
            }
            return "{\(pairs.map { "\(escapeJSON($0.key)):\($0.value.toJSON(indent: nil))" }.joined(separator: ","))}"
        }
    }
}

private func escapeJSON(_ s: String) -> String {
    var result = "\""
    for ch in s {
        switch ch {
        case "\"": result += "\\\""
        case "\\": result += "\\\\"
        case "\n": result += "\\n"
        case "\r": result += "\\r"
        case "\t": result += "\\t"
        default:
            if ch.asciiValue == nil && ch.unicodeScalars.first!.value < 0x20 {
                let code = ch.unicodeScalars.first!.value
                result += String(format: "\\u%04x", code)
            } else {
                result.append(ch)
            }
        }
    }
    result += "\""
    return result
}

// MARK: - Custom Encoder

private final class _OrderedEncoder: Encoder {
    var codingPath: [CodingKey] = []
    var userInfo: [CodingUserInfoKey: Any] = [:]
    var root: JSONNode = .null

    func container<Key: CodingKey>(keyedBy type: Key.Type) -> KeyedEncodingContainer<Key> {
        let container = _KeyedContainer<Key>(encoder: self, codingPath: codingPath)
        return KeyedEncodingContainer(container)
    }

    func unkeyedContainer() -> UnkeyedEncodingContainer {
        _UnkeyedContainer(encoder: self, codingPath: codingPath)
    }

    func singleValueContainer() -> SingleValueEncodingContainer {
        _SingleValueContainer(encoder: self, codingPath: codingPath)
    }
}

private final class _KeyedContainer<Key: CodingKey>: KeyedEncodingContainerProtocol {
    let encoder: _OrderedEncoder
    var codingPath: [CodingKey]
    var pairs: [(key: String, value: JSONNode)] = []

    init(encoder: _OrderedEncoder, codingPath: [CodingKey]) {
        self.encoder = encoder
        self.codingPath = codingPath
    }

    deinit { encoder.root = .object(pairs) }

    func encodeNil(forKey key: Key) throws { pairs.append((key.stringValue, .null)) }
    func encode(_ value: Bool, forKey key: Key) throws { pairs.append((key.stringValue, .bool(value))) }
    func encode(_ value: Int, forKey key: Key) throws { pairs.append((key.stringValue, .int(value))) }
    func encode(_ value: Int8, forKey key: Key) throws { pairs.append((key.stringValue, .int(Int(value)))) }
    func encode(_ value: Int16, forKey key: Key) throws { pairs.append((key.stringValue, .int(Int(value)))) }
    func encode(_ value: Int32, forKey key: Key) throws { pairs.append((key.stringValue, .int(Int(value)))) }
    func encode(_ value: Int64, forKey key: Key) throws { pairs.append((key.stringValue, .int(Int(value)))) }
    func encode(_ value: UInt, forKey key: Key) throws { pairs.append((key.stringValue, .int(Int(value)))) }
    func encode(_ value: UInt8, forKey key: Key) throws { pairs.append((key.stringValue, .int(Int(value)))) }
    func encode(_ value: UInt16, forKey key: Key) throws { pairs.append((key.stringValue, .int(Int(value)))) }
    func encode(_ value: UInt32, forKey key: Key) throws { pairs.append((key.stringValue, .int(Int(value)))) }
    func encode(_ value: UInt64, forKey key: Key) throws { pairs.append((key.stringValue, .int(Int(value)))) }
    func encode(_ value: Float, forKey key: Key) throws { pairs.append((key.stringValue, .double(Double(value)))) }
    func encode(_ value: Double, forKey key: Key) throws { pairs.append((key.stringValue, .double(value))) }
    func encode(_ value: String, forKey key: Key) throws { pairs.append((key.stringValue, .string(value))) }

    func encode<T: Encodable>(_ value: T, forKey key: Key) throws {
        let sub = _OrderedEncoder()
        sub.codingPath = codingPath + [key]
        try value.encode(to: sub)
        pairs.append((key.stringValue, sub.root))
    }

    func nestedContainer<NestedKey: CodingKey>(keyedBy keyType: NestedKey.Type, forKey key: Key) -> KeyedEncodingContainer<NestedKey> {
        let sub = _OrderedEncoder()
        sub.codingPath = codingPath + [key]
        let container = _KeyedContainer<NestedKey>(encoder: sub, codingPath: sub.codingPath)
        pairs.append((key.stringValue, sub.root))
        return KeyedEncodingContainer(container)
    }

    func nestedUnkeyedContainer(forKey key: Key) -> UnkeyedEncodingContainer {
        let sub = _OrderedEncoder()
        sub.codingPath = codingPath + [key]
        pairs.append((key.stringValue, sub.root))
        return _UnkeyedContainer(encoder: sub, codingPath: sub.codingPath)
    }

    func superEncoder() -> Encoder { encoder }
    func superEncoder(forKey key: Key) -> Encoder { encoder }
}

private final class _UnkeyedContainer: UnkeyedEncodingContainer {
    let encoder: _OrderedEncoder
    var codingPath: [CodingKey]
    var count = 0
    var items: [JSONNode] = []

    init(encoder: _OrderedEncoder, codingPath: [CodingKey]) {
        self.encoder = encoder
        self.codingPath = codingPath
    }

    deinit { encoder.root = .array(items) }

    func encodeNil() throws { items.append(.null); count += 1 }
    func encode(_ value: Bool) throws { items.append(.bool(value)); count += 1 }
    func encode(_ value: Int) throws { items.append(.int(value)); count += 1 }
    func encode(_ value: Int8) throws { items.append(.int(Int(value))); count += 1 }
    func encode(_ value: Int16) throws { items.append(.int(Int(value))); count += 1 }
    func encode(_ value: Int32) throws { items.append(.int(Int(value))); count += 1 }
    func encode(_ value: Int64) throws { items.append(.int(Int(value))); count += 1 }
    func encode(_ value: UInt) throws { items.append(.int(Int(value))); count += 1 }
    func encode(_ value: UInt8) throws { items.append(.int(Int(value))); count += 1 }
    func encode(_ value: UInt16) throws { items.append(.int(Int(value))); count += 1 }
    func encode(_ value: UInt32) throws { items.append(.int(Int(value))); count += 1 }
    func encode(_ value: UInt64) throws { items.append(.int(Int(value))); count += 1 }
    func encode(_ value: Float) throws { items.append(.double(Double(value))); count += 1 }
    func encode(_ value: Double) throws { items.append(.double(value)); count += 1 }
    func encode(_ value: String) throws { items.append(.string(value)); count += 1 }

    func encode<T: Encodable>(_ value: T) throws {
        let sub = _OrderedEncoder()
        try value.encode(to: sub)
        items.append(sub.root)
        count += 1
    }

    func nestedContainer<NestedKey: CodingKey>(keyedBy keyType: NestedKey.Type) -> KeyedEncodingContainer<NestedKey> {
        let sub = _OrderedEncoder()
        items.append(sub.root)
        count += 1
        return KeyedEncodingContainer(_KeyedContainer<NestedKey>(encoder: sub, codingPath: codingPath))
    }

    func nestedUnkeyedContainer() -> UnkeyedEncodingContainer {
        let sub = _OrderedEncoder()
        items.append(sub.root)
        count += 1
        return _UnkeyedContainer(encoder: sub, codingPath: codingPath)
    }

    func superEncoder() -> Encoder { encoder }
}

private final class _SingleValueContainer: SingleValueEncodingContainer {
    let encoder: _OrderedEncoder
    var codingPath: [CodingKey]

    init(encoder: _OrderedEncoder, codingPath: [CodingKey]) {
        self.encoder = encoder
        self.codingPath = codingPath
    }

    func encodeNil() throws { encoder.root = .null }
    func encode(_ value: Bool) throws { encoder.root = .bool(value) }
    func encode(_ value: Int) throws { encoder.root = .int(value) }
    func encode(_ value: Int8) throws { encoder.root = .int(Int(value)) }
    func encode(_ value: Int16) throws { encoder.root = .int(Int(value)) }
    func encode(_ value: Int32) throws { encoder.root = .int(Int(value)) }
    func encode(_ value: Int64) throws { encoder.root = .int(Int(value)) }
    func encode(_ value: UInt) throws { encoder.root = .int(Int(value)) }
    func encode(_ value: UInt8) throws { encoder.root = .int(Int(value)) }
    func encode(_ value: UInt16) throws { encoder.root = .int(Int(value)) }
    func encode(_ value: UInt32) throws { encoder.root = .int(Int(value)) }
    func encode(_ value: UInt64) throws { encoder.root = .int(Int(value)) }
    func encode(_ value: Float) throws { encoder.root = .double(Double(value)) }
    func encode(_ value: Double) throws { encoder.root = .double(value) }
    func encode(_ value: String) throws { encoder.root = .string(value) }

    func encode<T: Encodable>(_ value: T) throws {
        let sub = _OrderedEncoder()
        try value.encode(to: sub)
        encoder.root = sub.root
    }
}
