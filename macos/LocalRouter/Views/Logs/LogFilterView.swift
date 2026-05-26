import SwiftUI

struct LogFilterView: View {
    @Environment(AppState.self) private var appState
    @Environment(LogsStore.self) private var store
    @State private var showAdvanced = false

    var body: some View {
        @Bindable var store = store

        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Picker("时间窗口", selection: $store.window) {
                    ForEach(MetricsWindow.allCases, id: \.self) { w in
                        Text(w.displayName).tag(w)
                    }
                }
                .frame(width: 120)

                TextField("会话 ID", text: $store.session)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 160)

                Button("高级筛选") {
                    showAdvanced.toggle()
                }
                .buttonStyle(.borderless)

                Spacer()

                Button("重置") {
                    store.resetFilters()
                }
                .buttonStyle(.borderless)

                Button("查询") {
                    Task { await store.fetchFirstPage(api: appState.apiClient) }
                }
                .buttonStyle(.bordered)

                Menu("导出") {
                    Button("CSV") { exportLogs(format: .csv) }
                    Button("JSON") { exportLogs(format: .json) }
                }
                .menuStyle(.borderlessButton)
            }

            if showAdvanced {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 12) {
                        TextField("关键字", text: $store.keyword)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 160)

                        TextField("服务商", text: $store.provider)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 120)

                        TextField("路由类型", text: $store.routeType)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 120)

                        TextField("原始模型", text: $store.modelIn)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 120)

                        TextField("路由模型", text: $store.modelOut)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 120)
                    }

                    HStack(spacing: 12) {
                        TextField("用户", text: $store.user)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 120)

                        Picker("错误", selection: Binding(
                            get: { store.hasError.map { $0 ? "error" : "ok" } ?? "all" },
                            set: { val in
                                switch val {
                                case "error": store.hasError = true
                                case "ok": store.hasError = false
                                default: store.hasError = nil
                                }
                            }
                        )) {
                            Text("全部").tag("all")
                            Text("仅错误").tag("error")
                            Text("仅成功").tag("ok")
                        }
                        .frame(width: 120)
                    }
                }
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
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
