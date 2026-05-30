import Foundation

enum MetricsWindow: String, Codable, Sendable, CaseIterable {
    case oneHour = "1h"
    case sixHours = "6h"
    case twentyFourHours = "24h"

    var displayName: String {
        switch self {
        case .oneHour: "1 小时"
        case .sixHours: "6 小时"
        case .twentyFourHours: "24 小时"
        }
    }
}

// 日志检索与用户会话使用的时间窗口，比指标面板支持更长的范围。
enum LogQueryWindow: String, Codable, Sendable, CaseIterable {
    case oneHour = "1h"
    case sixHours = "6h"
    case twentyFourHours = "24h"
    case sevenDays = "7d"
    case oneMonth = "1mo"
    case oneYear = "1y"

    var displayName: String {
        switch self {
        case .oneHour: "1 小时"
        case .sixHours: "6 小时"
        case .twentyFourHours: "24 小时"
        case .sevenDays: "7 天"
        case .oneMonth: "1 个月"
        case .oneYear: "1 年"
        }
    }

    var seconds: TimeInterval {
        switch self {
        case .oneHour: 3600
        case .sixHours: 6 * 3600
        case .twentyFourHours: 24 * 3600
        case .sevenDays: 7 * 24 * 3600
        case .oneMonth: 30 * 24 * 3600
        case .oneYear: 365 * 24 * 3600
        }
    }
}

struct LogMetricsResponse: Codable, Sendable {
    let window: String
    let from: String
    let to: String
    let generatedAt: String
    let source: MetricsSource
    let summary: MetricsSummary
    let tokens: MetricsTokens?
    let series: [MetricsSeriesPoint]
    let topProviders: [MetricsTopItem]
    let topRouteTypes: [MetricsTopItem]
    let statusClasses: MetricsStatusClasses
    let warnings: [String]
}

struct MetricsTokens: Codable, Sendable {
    let usageCount: Int
    let inputTokens: Int
    let outputTokens: Int
    let totalTokens: Int
    let cachedInputTokens: Int
    let cacheHitInputTokens: Int
    let cacheHitRateDenominatorTokens: Int
    let cacheHitRate: Double
    let reasoningTokens: Int
    let cost: Double?
}

struct MetricsSource: Codable, Sendable {
    let logEnabled: Bool
    let baseDir: String?
    let filesScanned: Int
    let linesScanned: Int
    let partial: Bool
}

struct MetricsSummary: Codable, Sendable {
    let totalRequests: Int
    let successRequests: Int
    let errorRequests: Int
    let successRate: Double
    let avgLatencyMs: Double
    let p95LatencyMs: Double
    let totalRequestBytes: Int
    let totalResponseBytes: Int
}

struct MetricsSeriesPoint: Codable, Identifiable, Sendable {
    let ts: String
    let requests: Int
    let errors: Int
    let avgLatencyMs: Double

    var id: String { ts }

    var date: Date? {
        ISO8601DateFormatter().date(from: ts)
    }
}

struct MetricsTopItem: Codable, Identifiable, Sendable {
    let key: String
    let requests: Int
    let errorRate: Double?
    let avgLatencyMs: Double?

    var id: String { key }
}

struct MetricsStatusClasses: Codable, Sendable {
    let twoXX: Int
    let fourXX: Int
    let fiveXX: Int
    let networkError: Int

    enum CodingKeys: String, CodingKey {
        case twoXX = "2xx"
        case fourXX = "4xx"
        case fiveXX = "5xx"
        case networkError = "network_error"
    }
}

struct LogStorageInfo: Codable, Sendable {
    let totalBytes: Int
    let eventsBytes: Int
    let streamsBytes: Int
    let indexBytes: Int
    let fileCount: Int
    let lastUpdatedAt: String
    let isCalculating: Bool
}
