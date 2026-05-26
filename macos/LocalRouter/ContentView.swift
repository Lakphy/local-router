import SwiftUI

struct ContentView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        Group {
            if appState.isConnected {
                MainView()
            } else {
                ConnectionView()
            }
        }
        .task {
            await appState.autoConnect()
        }
    }
}
