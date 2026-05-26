import Foundation

struct AppConfig: Codable, Equatable, Sendable {
    var routes: OrderedMap<OrderedMap<RouteTarget>>
    var providers: OrderedMap<ProviderConfig>
    var server: ServerConfig?
    var log: LogConfig?
}

struct RouteTarget: Codable, Equatable, Sendable {
    var provider: String
    var model: String
}

struct ProviderConfig: Codable, Equatable, Sendable {
    var type: ProviderType
    var base: String
    var apiKey: String
    var proxy: String?
    var models: [String: ModelCapabilities]
    var plugins: [PluginConfig]?
}

enum ProviderType: String, Codable, Equatable, Sendable, CaseIterable {
    case openaiCompletions = "openai-completions"
    case openaiResponses = "openai-responses"
    case anthropicMessages = "anthropic-messages"

    var displayName: String {
        switch self {
        case .openaiCompletions: "OpenAI Completions"
        case .openaiResponses: "OpenAI Responses"
        case .anthropicMessages: "Anthropic Messages"
        }
    }
}

struct ModelCapabilities: Codable, Equatable, Sendable {
    var imageInput: Bool?
    var reasoning: Bool?

    enum CodingKeys: String, CodingKey {
        case imageInput = "image-input"
        case reasoning
    }
}

struct PluginConfig: Codable, Equatable, Sendable {
    var package: String
    var params: [String: AnyCodable]?
}

struct ServerConfig: Codable, Equatable, Sendable {
    var lanAccess: LanAccessConfig?
    var autostart: Bool?
    var host: String?
    var port: Int?
    var idleTimeout: Int?
}

struct LanAccessConfig: Codable, Equatable, Sendable {
    var enabled: Bool?
}

struct LogConfig: Codable, Equatable, Sendable {
    var enabled: Bool?
    var baseDir: String?
    var events: LogEventsConfig?
    var streams: LogStreamsConfig?
    var bodyPolicy: BodyPolicy?
}

enum BodyPolicy: String, Codable, Equatable, Sendable, CaseIterable {
    case off
    case masked
    case full
}

struct LogEventsConfig: Codable, Equatable, Sendable {
    var retainDays: Int?
}

struct LogStreamsConfig: Codable, Equatable, Sendable {
    var enabled: Bool?
    var retainDays: Int?
    var maxBytesPerRequest: Int?
}

struct ConfigMeta: Codable, Sendable {
    let configPath: String
    let routeTypes: [String]
}

struct AutostartStatus: Codable, Sendable {
    let enabled: Bool
    let systemInstalled: Bool
    let platform: String
    let servicePath: String
}

struct EncryptedPayload: Codable, Sendable {
    let iv: String
    let data: String
}

// MARK: - AnyCodable for plugin params

struct AnyCodable: Codable, Equatable, Sendable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = NSNull()
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map(\.value)
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues(\.value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported type")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case is NSNull:
            try container.encodeNil()
        case let bool as Bool:
            try container.encode(bool)
        case let int as Int:
            try container.encode(int)
        case let double as Double:
            try container.encode(double)
        case let string as String:
            try container.encode(string)
        case let array as [Any]:
            try container.encode(array.map { AnyCodable($0) })
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default:
            throw EncodingError.invalidValue(value, .init(codingPath: [], debugDescription: "Unsupported type"))
        }
    }

    static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
        let lhsData = try? JSONEncoder().encode(lhs)
        let rhsData = try? JSONEncoder().encode(rhs)
        return lhsData == rhsData
    }
}
