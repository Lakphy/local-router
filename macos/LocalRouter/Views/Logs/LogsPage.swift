import SwiftUI

struct LogsPage: View {
    @Environment(AppState.self) private var appState
    @Environment(LogsStore.self) private var store

    var body: some View {
        @Bindable var store = store

        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("日志检索")
                        .font(.title2)
                        .fontWeight(.semibold)
                    Text("查询和分析请求日志")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()

                Toggle("实时", isOn: Binding(
                    get: { store.realtimeEnabled },
                    set: { enabled in
                        if enabled {
                            store.startRealtime(wsURL: appState.connectionSettings.wsURL)
                        } else {
                            store.stopRealtime()
                        }
                    }
                ))
                .toggleStyle(.switch)
                .disabled(!store.canEnableRealtime)
            }
            .padding()

            Divider()

            // Filters
            LogFilterView()

            Divider()

            // Stats
            if let stats = store.stats {
                LogStatsBarView(stats: stats)
                    .padding(.horizontal)
                    .padding(.vertical, 8)
                Divider()
            }

            // Table
            LogTableView()
        }
        .task {
            await store.fetchFirstPage(api: appState.apiClient)
        }
    }
}
