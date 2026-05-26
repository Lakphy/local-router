import Foundation

struct LogSessionsResponse: Codable, Sendable {
    let from: String
    let to: String
    let summary: SessionsSummary
    let users: [LogUserSummary]
    let meta: SessionsMeta
}

struct SessionsSummary: Codable, Sendable {
    let totalRequests: Int
    let metadataRequests: Int
    let uniqueUsers: Int
    let uniqueSessions: Int
}

struct LogUserSummary: Codable, Identifiable, Sendable {
    let userKey: String
    let requestCount: Int
    let sessionCount: Int
    let firstSeenAt: String
    let lastSeenAt: String
    let models: [KeyCount]
    let providers: [KeyCount]
    let routeTypes: [KeyCount]
    let sessions: [LogSessionSummary]

    var id: String { userKey }
}

struct LogSessionSummary: Codable, Identifiable, Sendable {
    let sessionId: String
    let requestCount: Int
    let firstSeenAt: String
    let lastSeenAt: String
    let models: [KeyCount]
    let latestRequestId: String

    var id: String { sessionId }
}

struct KeyCount: Codable, Identifiable, Sendable {
    let key: String
    let count: Int

    var id: String { key }
}

struct SessionsMeta: Codable, Sendable {
    let scannedFiles: Int
    let scannedLines: Int
    let parseErrors: Int
    let truncated: Bool
}
