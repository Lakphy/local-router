import SwiftUI

struct DashboardPage: View {
    @Environment(AppState.self) private var appState
    @Environment(DashboardStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("仪表盘")
                .font(.title2)
                .fontWeight(.semibold)
            Text("Local Router 服务状态与配置概览")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            OverviewStripView()

            Spacer()
        }
        .padding()
        .task {
            await store.refresh(api: appState.apiClient)
        }
    }
}
