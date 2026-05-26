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
