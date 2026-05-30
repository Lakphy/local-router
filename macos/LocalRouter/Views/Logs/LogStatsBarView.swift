import SwiftUI

struct LogStatsBarView: View {
    let stats: LogQueryStats

    private let cardWidth: CGFloat = 130

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                statCard("总条数", value: Formatters.formatNumber(stats.total))
                statCard("Total Token", value: Formatters.formatCompact(stats.totalTokens))
                statCard("Input Token", value: Formatters.formatCompact(stats.inputTokens))
                statCard("Output Token", value: Formatters.formatCompact(stats.outputTokens))
                statCard("缓存命中率", value: Formatters.formatPercent(stats.cacheHitRate ?? 0))
                statCard("缓存命中 Token", value: Formatters.formatCompact(stats.cacheHitInputTokens))
                statCard("错误率", value: Formatters.formatPercent(stats.errorRate),
                         valueColor: stats.errorRate > 0 ? .red : .primary)
                statCard("P95", value: "\(Int(stats.p95LatencyMs)) ms")
            }
        }
    }

    private func statCard(_ title: String, value: String, valueColor: Color = .primary) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Text(value)
                .font(.title3)
                .fontWeight(.semibold)
                .foregroundStyle(valueColor)
                .lineLimit(1)
        }
        .frame(width: cardWidth, alignment: .leading)
        .padding(10)
        .cardSurface()
    }
}
