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

struct LogMetricsResponse: Codable, Sendable {
    let window: String
    let from: String
    let to: String
    let generatedAt: String
    let source: MetricsSource
    let summary: MetricsSummary
    let series: [MetricsSeriesPoint]
    let topProviders: [MetricsTopItem]
    let topRouteTypes: [MetricsTopItem]
    let statusClasses: MetricsStatusClasses
    let warnings: [String]
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
