import SwiftUI

struct GeneralSettingsPage: View {
    @Environment(AppState.self) private var appState
    @Environment(ConfigStore.self) private var configStore
    @State private var autostartStatus: AutostartStatus?
    @State private var autostartLoading = false
    @State private var autostartError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let draft = configStore.draft {
                    Form {
                        Section("服务器") {
                            TextField("主机", text: Binding(
                                get: { draft.server?.host ?? "" },
                                set: { newValue in
                                    configStore.updateDraft {
                                        $0.server = $0.server ?? ServerConfig()
                                        $0.server?.host = newValue.isEmpty ? nil : newValue
                                    }
                                }
                            ))

                            TextField("端口", value: Binding(
                                get: { draft.server?.port ?? 4099 },
                                set: { newValue in
                                    configStore.updateDraft {
                                        $0.server = $0.server ?? ServerConfig()
                                        $0.server?.port = newValue
                                    }
                                }
                            ), format: .number)

                            TextField("空闲超时 (秒)", value: Binding(
                                get: { draft.server?.idleTimeout ?? 0 },
                                set: { newValue in
                                    configStore.updateDraft {
                                        $0.server = $0.server ?? ServerConfig()
                                        $0.server?.idleTimeout = newValue > 0 ? newValue : nil
                                    }
                                }
                            ), format: .number)
                        }

                        Section("局域网访问") {
                            Toggle("允许局域网访问", isOn: Binding(
                                get: { draft.server?.lanAccess?.enabled ?? false },
                                set: { val in
                                    configStore.updateDraft {
                                        $0.server = $0.server ?? ServerConfig()
                                        $0.server?.lanAccess = LanAccessConfig(enabled: val)
                                    }
                                }
                            ))
                        }

                        Section("开机自启动") {
                            if let status = autostartStatus {
                                Toggle("启用自启动", isOn: Binding(
                                    get: { status.enabled },
                                    set: { enabled in
                                        Task {
                                            autostartLoading = true
                                            try? await appState.apiClient.setAutostart(enabled: enabled)
                                            autostartStatus = try? await appState.apiClient.fetchAutostartStatus()
                                            autostartLoading = false
                                        }
                                    }
                                ))
                                .disabled(autostartLoading)

                                Text("平台: \(status.platform)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)

                                if !status.servicePath.isEmpty {
                                    Text("服务路径: \(status.servicePath)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            } else if let autostartError {
                                Text(autostartError)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            } else {
                                ProgressView()
                                    .controlSize(.small)
                            }
                        }
                    }
                    .formStyle(.grouped)
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .padding(DS.padPage)
        }
        .contentScroll()
        .task {
            do {
                autostartStatus = try await appState.apiClient.fetchAutostartStatus()
            } catch {
                autostartError = "无法加载自启动状态，服务器可能不支持此功能"
            }
        }
    }
}

