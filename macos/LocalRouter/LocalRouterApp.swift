import SwiftUI

@main
struct LocalRouterApp: App {
    @State private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(appState)
                .environment(appState.apiClient)
                .environment(appState.configStore)
                .environment(appState.dashboardStore)
                .environment(appState.logsStore)
                .environment(appState.sessionsStore)
        }
        .defaultSize(width: 900, height: 600)
        .windowResizability(.contentMinSize)
    }
}
