import Foundation

struct OrderedMap<Value: Codable & Equatable & Sendable>: Equatable, Sendable, Codable {
    private var _keys: [String] = []
    private var _storage: [String: Value] = [:]

    init() {}

    var keys: [String] { _keys }
    var count: Int { _keys.count }
    var isEmpty: Bool { _keys.isEmpty }
    var values: [Value] { _keys.compactMap { _storage[$0] } }

    subscript(key: String) -> Value? {
        get { _storage[key] }
        set {
            if let newValue {
                if _storage[key] == nil {
                    _keys.append(key)
                }
                _storage[key] = newValue
            } else {
                _keys.removeAll { $0 == key }
                _storage.removeValue(forKey: key)
            }
        }
    }

    @discardableResult
    mutating func removeValue(forKey key: String) -> Value? {
        _keys.removeAll { $0 == key }
        return _storage.removeValue(forKey: key)
    }

    func filter(_ isIncluded: (String, Value) -> Bool) -> [(key: String, value: Value)] {
        _keys.compactMap { key in
            guard let value = _storage[key], isIncluded(key, value) else { return nil }
            return (key: key, value: value)
        }
    }

    // MARK: - Codable

    private struct StringKey: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(_ string: String) { self.stringValue = string }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: StringKey.self)
        for key in container.allKeys {
            let value = try container.decode(Value.self, forKey: key)
            _keys.append(key.stringValue)
            _storage[key.stringValue] = value
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: StringKey.self)
        for key in _keys {
            if let value = _storage[key] {
                try container.encode(value, forKey: StringKey(key))
            }
        }
    }
}
