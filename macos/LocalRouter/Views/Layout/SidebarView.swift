import SwiftUI

struct SidebarView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        @Bindable var appState = appState

        List(selection: $appState.selectedPage) {
            Section("观测") {
                ForEach(NavigationPage.observePages, id: \.self) { page in
                    Label(page.title, systemImage: page.icon)
                        .tag(page)
                }
            }

            Section("配置") {
                ForEach(NavigationPage.configPages, id: \.self) { page in
                    Label(page.title, systemImage: page.icon)
                        .tag(page)
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Local Router")
    }
}
