import SwiftUI

struct OverviewStripView: View {
    @Environment(AppState.self) private var appState
    @Environment(DashboardStore.self) private var store
    @Environment(ConfigStore.self) private var configStore

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
            StatBoxView(
                "服务状态",
                value: store.isHealthy ? "运行中" : "离线",
                valueColor: store.isHealthy ? .green : .red
            )

            StatBoxView(
                "服务商",
                value: "\(configStore.config?.providers.count ?? 0)",
                subtitle: "已配置"
            )

            StatBoxView(
                "路由规则",
                value: "\(totalRoutes)",
                subtitle: "\(configStore.config?.routes.count ?? 0) 个协议入口"
            )

            if let storage = store.logStorage {
                StatBoxView(
                    "日志存储",
                    value: Formatters.formatBytes(storage.totalBytes),
                    subtitle: "\(storage.fileCount) 个文件"
                )
            } else {
                StatBoxView("日志存储", value: "-")
            }
        }
    }

    private var totalRoutes: Int {
        configStore.config?.routes.values.reduce(0) { $0 + $1.count } ?? 0
    }
}
