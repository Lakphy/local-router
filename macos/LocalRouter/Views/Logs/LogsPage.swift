import SwiftUI
import AppKit

struct LogsPage: View {
    @Environment(AppState.self) private var appState
    @Environment(LogsStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
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
        .toolbar {
            ToolbarItem(placement: .automatic) {
                Menu {
                    Button("CSV") { exportLogs(format: .csv) }
                    Button("JSON") { exportLogs(format: .json) }
                } label: {
                    Label("导出", systemImage: "square.and.arrow.up")
                }
            }
        }
        .task {
            await store.fetchFirstPage(api: appState.apiClient)
        }
    }

    private func exportLogs(format: ExportFormat) {
        Task {
            let params = LogQueryParams(window: store.window)
            guard let data = try? await appState.apiClient.exportLogEvents(params: params, format: format) else { return }

            let panel = NSSavePanel()
            panel.nameFieldStringValue = "logs-export.\(format.rawValue)"
            panel.allowedContentTypes = format == .csv ? [.commaSeparatedText] : [.json]

            if panel.runModal() == .OK, let url = panel.url {
                try? data.write(to: url)
            }
        }
    }
}
