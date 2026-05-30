import SwiftUI

struct MainView: View {
    @Environment(AppState.self) private var appState
    @Environment(ConfigStore.self) private var configStore

    var body: some View {
        @Bindable var configStore = configStore

        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 160, ideal: 180, max: 240)
        } detail: {
            detailView
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .navigationTitle(appState.selectedPage.title)
                .navigationSubtitle(appState.selectedPage.subtitle)
                .toolbar {
                    if appState.selectedPage.isConfigPage {
                        ActionBarView()
                    }
                }
        }
        .sheet(isPresented: $configStore.showDiffSheet) {
            ConfigDiffSheet()
        }
        .sheet(isPresented: $configStore.showRawEditor) {
            ConfigRawEditorSheet()
        }
        .alert(configStore.resultAlertSuccess ? "操作成功" : "操作失败", isPresented: $configStore.showResultAlert) {
            Button("好") {}
        } message: {
            Text(configStore.resultAlertMessage)
        }
        .alert("需要重启服务", isPresented: $configStore.showRestartAlert) {
            Button("稍后", role: .cancel) {}
            Button("立即重启") {
                let port = configStore.restartListenPort
                Task { await appState.restartServerAndReconnect(port: port) }
            }
        } message: {
            Text("监听地址已更改，需要重启服务才能生效。重启后将连接到端口 \(String(configStore.restartListenPort))。")
        }
    }

    @ViewBuilder
    private var detailView: some View {
        switch appState.selectedPage {
        case .dashboard:
            DashboardPage()
        case .logs:
            LogsPage()
        case .sessions:
            SessionsPage()
        case .generalSettings:
            GeneralSettingsPage()
        case .providers:
            ProvidersPage()
        case .routes:
            RoutesPage()
        case .logsSettings:
            LogsSettingsPage()
        }
    }
}
