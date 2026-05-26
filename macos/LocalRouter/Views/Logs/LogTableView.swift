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
            } else if store.items.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "doc.text")
                        .font(.largeTitle)
                        .foregroundStyle(.secondary)
                    Text("暂无日志")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
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
                    }
                    .width(min: 60, ideal: 80)

                    TableColumn("模型") { item in
                        Text(item.model)
                            .font(.system(.caption, design: .monospaced))
                            .lineLimit(1)
                    }
                    .width(min: 80, ideal: 140)

                    TableColumn("状态") { item in
                        StatusBadge.forStatusClass(item.statusClass)
                    }
                    .width(50)

                    TableColumn("延迟") { item in
                        Text(Formatters.formatLatency(item.latencyMs))
                            .font(.caption)
                    }
                    .width(60)
                }
                .onChange(of: selectedLogId) { _, newId in
                    if let id = newId {
                        openLogDetailInBrowser(id: id)
                        selectedLogId = nil
                    }
                }

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
    }

    private func openLogDetailInBrowser(id: String) {
        let encodedId = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let urlString = "\(appState.connectionSettings.baseURL)/admin/logs/\(encodedId)"
        if let url = URL(string: urlString) {
            NSWorkspace.shared.open(url)
        }
    }
}
