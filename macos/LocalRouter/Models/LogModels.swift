import Foundation

enum LogLevel: String, Codable, Sendable {
    case info
    case error
}

enum StatusClass: String, Codable, Sendable {
    case twoXX = "2xx"
    case fourXX = "4xx"
    case fiveXX = "5xx"
    case networkError = "network_error"

    var displayName: String {
        rawValue
    }

    var isError: Bool {
        self != .twoXX
    }
}

struct LogEventSummary: Codable, Identifiable, Sendable {
    let id: String
    let ts: String
    let level: LogLevel
    let provider: String
    let routeType: String
    let model: String
    let modelIn: String
    let modelOut: String
    let path: String
    let requestId: String
    let latencyMs: Double
    let upstreamStatus: Int
    let statusClass: StatusClass
    let hasError: Bool
    let message: String
    let errorType: String?
    let hasMetadata: Bool
    let userIdRaw: String?
    let userKey: String?
    let sessionId: String?
    let tokenUsage: TokenUsageSummary?

    var date: Date? {
        ISO8601DateFormatter().date(from: ts)
    }
}

struct LogQueryStats: Codable, Sendable {
    let total: Int
    let errorCount: Int
    let errorRate: Double
    let avgLatencyMs: Double
    let p95LatencyMs: Double
    let tokenUsageCount: Int?
    let inputTokens: Int?
    let outputTokens: Int?
    let totalTokens: Int?
    let cachedInputTokens: Int?
    let cacheHitInputTokens: Int?
    let cacheHitRate: Double?
    let cacheHitRateDenominatorTokens: Int?
    let cacheReadInputTokens: Int?
    let cacheCreationInputTokens: Int?
    let cacheWriteInputTokens: Int?
    let cacheMissInputTokens: Int?
    let reasoningTokens: Int?
    let billableInputTokens: Int?
    let billableOutputTokens: Int?
}

struct LogQueryMeta: Codable, Sendable {
    let scannedFiles: Int
    let scannedLines: Int
    let parseErrors: Int
    let truncated: Bool
    let indexUsed: Bool?
    let indexFresh: Bool?
    let usesFts: Bool?
    let queryMs: Double?
    let rowsReturned: Int?
    let fallbackReason: String?
    let statsMode: String?
}

struct LogEventsResponse: Codable, Sendable {
    let items: [LogEventSummary]
    let nextCursor: String?
    let hasMore: Bool
    let stats: LogQueryStats
    let meta: LogQueryMeta
}

// MARK: - Log Event Detail

struct LogEventDetail: Codable, Sendable {
    let id: String
    let summary: LogDetailSummary
    let usage: LogDetailUsage
    let request: LogDetailRequest
    let response: LogDetailResponse
    let upstream: LogDetailUpstream
    let capture: LogDetailCapture
    let plugins: LogDetailPlugins?
    let rawEvent: AnyCodable?
    let location: LogDetailLocation
}

struct LogDetailSummary: Codable, Sendable {
    let id: String
    let ts: String
    let level: LogLevel
    let provider: String
    let routeType: String
    let routeRuleKey: String
    let requestId: String
    let latencyMs: Double
    let upstreamStatus: Int
    let statusClass: StatusClass
    let hasError: Bool
    let model: String
    let modelIn: String
    let modelOut: String
    let tokenUsage: TokenUsageSummary?
}

struct LogDetailUsage: Codable, Sendable {
    let tokenUsage: TokenUsageSummary?
    let requestBytes: Int
    let responseBytes: Int?
    let streamBytes: Int?
    let streamFileBytes: Int?
    let streamFileTruncated: Bool
}

struct LogDetailRequest: Codable, Sendable {
    let method: String
    let path: String
    let contentType: String?
    let requestHeaders: [String: String]?
    let requestBody: AnyCodable?
}

struct LogDetailResponse: Codable, Sendable {
    let upstreamStatus: Int
    let contentType: String?
    let responseHeaders: [String: String]?
    let responseBody: String?
}

struct LogDetailUpstream: Codable, Sendable {
    let targetUrl: String
    let proxyUrl: String?
    let providerRequestId: String?
    let errorType: String?
    let errorMessage: String?
    let isStream: Bool
    let streamFile: String?
    let streamContent: String?
}

struct LogDetailCapture: Codable, Sendable {
    let bodyPolicy: String
    let requestBodyAvailable: Bool
    let responseBodyAvailable: Bool
    let streamCaptured: Bool
    let truncatedHints: [String]
}

struct LogDetailPlugins: Codable, Sendable {
    let request: [PluginPhaseInfo]?
    let response: [PluginPhaseInfo]?
    let requestBodyAfterPlugins: AnyCodable?
    let requestUrlAfterPlugins: String?
    let responseBodyBeforePlugins: String?
    let responseBodyAfterPlugins: String?
}

struct PluginPhaseInfo: Codable, Sendable {
    let name: String
    let package: String
    let params: [String: AnyCodable]
}

struct LogDetailLocation: Codable, Sendable {
    let date: String
    let line: Int
    let file: String
}
