import SwiftUI
import AppKit

struct LogTableView: View {
    @Environment(AppState.self) private var appState
    @Environment(LogsStore.self) private var store

    @State private var selectedLogId: String?

    var body: some View {
        VStack(spacing: 0) {
            if store.loading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = store.error, store.items.isEmpty {
                ContentUnavailableView(
                    "日志查询失败",
                    systemImage: "exclamationmark.triangle",
                    description: Text(error)
                )
            } else if store.items.isEmpty {
                ContentUnavailableView(
                    "暂无日志",
                    systemImage: "doc.text.magnifyingglass",
                    description: Text("调整筛选条件后点击查询")
                )
            } else {
                Table(store.items, selection: $selectedLogId) {
                    TableColumn("时间") { item in
                        Text(Formatters.formatDateTime(item.ts))
                            .font(.system(.caption, design: .monospaced))
                    }
                    .width(min: 100, ideal: 120)

                    TableColumn("级别") { item in
                        StatusBadge.forLevel(item.level)
                    }
                    .width(50)

                    TableColumn("服务商") { item in
                        Text(item.provider)
                            .font(.caption)
                            .lineLimit(1)
                    }
                    .width(min: 60, ideal: 90)

                    TableColumn("路由") { item in
                        Text(item.routeType)
                            .font(.caption)
                            .lineLimit(1)
                    }
                    .width(min: 60, ideal: 90)

                    TableColumn("模型链路") { item in
                        Text("\(item.modelIn) → \(item.modelOut)")
                            .font(.system(.caption, design: .monospaced))
                            .lineLimit(1)
                            .help("\(item.modelIn) → \(item.modelOut)")
                    }
                    .width(min: 120, ideal: 200)

                    TableColumn("消息") { item in
                        Text(item.message)
                            .font(.caption)
                            .lineLimit(1)
                            .help(item.message)
                    }
                    .width(min: 100, ideal: 180)

                    TableColumn("延迟") { item in
                        Text(Formatters.formatLatency(item.latencyMs))
                            .font(.caption)
                    }
                    .width(60)

                    TableColumn("Usage") { item in
                        tokenUsageCell(item.tokenUsage)
                    }
                    .width(min: 130, ideal: 180)

                    TableColumn("状态") { item in
                        StatusBadge.forStatusClass(item.statusClass)
                    }
                    .width(50)

                    TableColumn("会话") { item in
                        Text(item.sessionId ?? "-")
                            .font(.system(.caption, design: .monospaced))
                            .lineLimit(1)
                            .foregroundStyle(item.sessionId == nil ? .secondary : .primary)
                    }
                    .width(min: 80, ideal: 160)
                }
                .contextMenu(forSelectionType: String.self) { ids in
                    if let id = ids.first {
                        Button {
                            openLogDetailInBrowser(id: id)
                        } label: {
                            Label("在浏览器打开", systemImage: "safari")
                        }
                        Button {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(id, forType: .string)
                        } label: {
                            Label("复制 ID", systemImage: "doc.on.doc")
                        }
                    }
                } primaryAction: { ids in
                    if let id = ids.first {
                        openLogDetailInBrowser(id: id)
                    }
                }
                .contentScroll()

                if store.hasMore {
                    Button {
                        Task { await store.fetchNextPage(api: appState.apiClient) }
                    } label: {
                        if store.loadingMore {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Text("加载更多")
                        }
                    }
                    .buttonStyle(.borderless)
                    .padding(8)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private func tokenUsageCell(_ usage: TokenUsageSummary?) -> some View {
        if let usage {
            VStack(alignment: .leading, spacing: 1) {
                Text("in \(Formatters.formatCompact(usage.inputTokens)) · out \(Formatters.formatCompact(usage.outputTokens))")
                Text("total \(Formatters.formatCompact(usage.totalTokens)) · cache \(Formatters.formatPercent(usage.cacheHitRate ?? 0))")
                    .foregroundStyle(.secondary)
            }
            .font(.caption2)
            .lineLimit(1)
        } else {
            Text("-")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private func openLogDetailInBrowser(id: String) {
        let encodedId = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let urlString = "\(appState.connectionSettings.baseURL)/admin/logs/\(encodedId)"
        if let url = URL(string: urlString) {
            NSWorkspace.shared.open(url)
        }
    }
}
