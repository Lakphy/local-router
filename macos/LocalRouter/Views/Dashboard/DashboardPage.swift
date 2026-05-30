import SwiftUI

struct DashboardPage: View {
    @Environment(AppState.self) private var appState
    @Environment(DashboardStore.self) private var store

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DS.gapL) {
                OverviewStripView()
                RouteConfigCard()
                ClientConfigCard()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(DS.padPage)
        }
        .contentScroll()
        .task {
            await store.refresh(api: appState.apiClient)
        }
    }
}
