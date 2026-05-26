import Foundation

struct TokenUsageSummary: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let source: String
    let providerStyle: String
    let inputTokens: Int?
    let outputTokens: Int?
    let totalTokens: Int?
    let cachedInputTokens: Int?
    let cacheHitInputTokens: Int?
    let cacheHitRate: Double?
    let cacheHitRateDenominatorTokens: Int?
    let cacheHitRateFormula: String?
    let cacheReadInputTokens: Int?
    let cacheCreationInputTokens: Int?
    let cacheCreationInputTokens5m: Int?
    let cacheCreationInputTokens1h: Int?
    let cacheWriteInputTokens: Int?
    let cacheMissInputTokens: Int?
    let reasoningTokens: Int?
    let audioInputTokens: Int?
    let audioOutputTokens: Int?
    let textInputTokens: Int?
    let textOutputTokens: Int?
    let acceptedPredictionTokens: Int?
    let rejectedPredictionTokens: Int?
    let toolUsePromptTokens: Int?
    let billableInputTokens: Int?
    let billableOutputTokens: Int?
    let creditUsage: Double?
    let cost: Double?
    let rawUsagePath: String?
    let warnings: [String]
}
