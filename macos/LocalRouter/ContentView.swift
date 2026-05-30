import SwiftUI

struct ContentView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        Group {
            if appState.isConnected {
                MainView()
                    .transition(.opacity.combined(with: .blurReplace))
            } else {
                ConnectionView()
                    .transition(.opacity.combined(with: .blurReplace))
            }
        }
        .animation(.smooth(duration: 0.35), value: appState.isConnected)
        .task {
            await appState.autoConnect()
        }
    }
}
