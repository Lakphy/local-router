import Foundation

enum JSONPrettyPrint {
    static func format(_ value: Any?) -> String {
        guard let value else { return "null" }
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]),
           let string = String(data: data, encoding: .utf8) {
            return string
        }
        return String(describing: value)
    }

    static func formatString(_ jsonString: String?) -> String {
        guard let jsonString, !jsonString.isEmpty else { return "null" }
        guard let data = jsonString.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data),
              let prettyData = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]),
              let pretty = String(data: prettyData, encoding: .utf8) else {
            return jsonString
        }
        return pretty
    }

    static func formatCodable<T: Encodable>(_ value: T) -> String {
        guard let string = try? OrderedJSONEncoder.encodeToString(value, prettyPrinted: true) else {
            return String(describing: value)
        }
        return string
    }
}
