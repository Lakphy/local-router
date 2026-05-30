import SwiftUI

struct OverviewStripView: View {
    @Environment(AppState.self) private var appState
    @Environment(DashboardStore.self) private var store

    private var windowBinding: Binding<MetricsWindow> {
        Binding(
            get: { store.metricsWindow },
            set: { newValue in
                Task { await store.fetchMetrics(api: appState.apiClient, window: newValue, refresh: true) }
            }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DS.gapS) {
            HStack {
                Text("运行指标 · 时间范围")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Picker("时间范围", selection: windowBinding) {
                    ForEach(MetricsWindow.allCases, id: \.self) { window in
                        Text(window.rawValue).tag(window)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 180)
            }

            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 3), spacing: 8) {
                StatBoxView(
                    "请求总量",
                    value: Formatters.formatCompact(summary?.totalRequests),
                    subtitle: summary.map { "成功 \($0.successRequests) · 错误 \($0.errorRequests)" } ?? "暂无数据"
                )

                StatBoxView(
                    "成功率",
                    value: summary.map { Formatters.formatPercent($0.successRate) } ?? "—",
                    subtitle: statusBreakdown
                )

                StatBoxView(
                    "P95 延迟",
                    value: summary.map { Formatters.formatLatency($0.p95LatencyMs) } ?? "—",
                    subtitle: summary.map { "平均 \(Formatters.formatLatency($0.avgLatencyMs))" } ?? "暂无数据"
                )

                StatBoxView(
                    "Token 用量",
                    value: tokens.map { Formatters.formatCompact($0.totalTokens) } ?? "—",
                    subtitle: tokens.map { "入 \(Formatters.formatCompact($0.inputTokens)) · 出 \(Formatters.formatCompact($0.outputTokens))" } ?? "暂无数据"
                )

                StatBoxView(
                    "缓存命中率",
                    value: tokens.map { Formatters.formatPercent($0.cacheHitRate) } ?? "—",
                    subtitle: tokens.map { "推理 \(Formatters.formatCompact($0.reasoningTokens)) tokens" } ?? "暂无数据"
                )

                if let storage = store.logStorage {
                    StatBoxView(
                        "日志存储",
                        value: Formatters.formatBytes(storage.totalBytes),
                        subtitle: "\(storage.fileCount) 个文件 · 不随时间范围变化"
                    )
                } else {
                    StatBoxView("日志存储", value: "—", subtitle: "计算中...")
                }
            }
        }
    }

    private var summary: MetricsSummary? { store.metrics?.summary }
    private var tokens: MetricsTokens? { store.metrics?.tokens }

    private var statusBreakdown: String {
        guard let s = store.metrics?.statusClasses else { return "暂无数据" }
        return "4xx \(s.fourXX) · 5xx \(s.fiveXX) · 网络 \(s.networkError)"
    }
}
