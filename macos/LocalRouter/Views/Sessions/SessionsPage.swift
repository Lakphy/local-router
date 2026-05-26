import SwiftUI

struct SessionsPage: View {
    @Environment(AppState.self) private var appState
    @Environment(SessionsStore.self) private var store
    @State private var expandedUsers: Set<String> = []

    var body: some View {
        @Bindable var store = store

        VStack(alignment: .leading, spacing: 0) {
            // Header
            VStack(alignment: .leading, spacing: 2) {
                Text("用户会话")
                    .font(.title2)
                    .fontWeight(.semibold)
                Text("按用户和会话聚合日志")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .padding()

            Divider()

            // Filters
            HStack(spacing: 12) {
                Picker("时间窗口", selection: $store.window) {
                    ForEach(MetricsWindow.allCases, id: \.self) { w in
                        Text(w.displayName).tag(w)
                    }
                }
                .frame(width: 120)

                TextField("用户", text: $store.user)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 120)

                TextField("关键字", text: $store.keyword)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 120)

                Spacer()

                Button("查询") {
                    Task { await store.fetchData(api: appState.apiClient) }
                }
                .buttonStyle(.bordered)
            }
            .padding(.horizontal)
            .padding(.vertical, 8)

            Divider()

            // Summary
            if let summary = store.response?.summary {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 4), spacing: 6) {
                    StatBoxView("总请求", value: Formatters.formatNumber(summary.totalRequests))
                    StatBoxView("元数据请求", value: Formatters.formatNumber(summary.metadataRequests))
                    StatBoxView("独立用户", value: Formatters.formatNumber(summary.uniqueUsers))
                    StatBoxView("独立会话", value: Formatters.formatNumber(summary.uniqueSessions))
                }
                .padding(.horizontal)
                .padding(.vertical, 8)

                Divider()
            }

            // User list
            if store.loading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let users = store.response?.users, !users.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(users) { user in
                            VStack(alignment: .leading, spacing: 0) {
                                // User header (clickable to toggle)
                                Button {
                                    withAnimation(.easeInOut(duration: 0.2)) {
                                        if expandedUsers.contains(user.userKey) {
                                            expandedUsers.remove(user.userKey)
                                        } else {
                                            expandedUsers.insert(user.userKey)
                                        }
                                    }
                                } label: {
                                    HStack(spacing: 6) {
                                        Image(systemName: expandedUsers.contains(user.userKey) ? "chevron.down" : "chevron.right")
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                            .frame(width: 12)

                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(user.userKey)
                                                .fontWeight(.medium)
                                            Text("\(user.sessionCount) 会话 · \(user.requestCount) 请求")
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        Text(Formatters.formatDateTime(user.lastSeenAt))
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 8)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)

                                // Sessions (expanded)
                                if expandedUsers.contains(user.userKey) {
                                    VStack(alignment: .leading, spacing: 1) {
                                        ForEach(user.sessions) { session in
                                            HStack {
                                                VStack(alignment: .leading, spacing: 2) {
                                                    Text(session.sessionId)
                                                        .font(.system(.caption, design: .monospaced))
                                                    Text("\(session.requestCount) 请求")
                                                        .font(.caption2)
                                                        .foregroundStyle(.secondary)
                                                }
                                                Spacer()
                                                Text(Formatters.formatDateTime(session.lastSeenAt))
                                                    .font(.caption)
                                                    .foregroundStyle(.secondary)

                                                Button("查看日志") {
                                                    navigateToLogs(user: user.userKey, session: session.sessionId)
                                                }
                                                .buttonStyle(.borderless)
                                                .font(.caption)
                                            }
                                            .padding(.horizontal, 12)
                                            .padding(.leading, 24)
                                            .padding(.vertical, 6)
                                        }
                                    }
                                }

                                Divider()
                            }
                        }
                    }
                }
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "person.2")
                        .font(.largeTitle)
                        .foregroundStyle(.secondary)
                    Text("暂无用户会话数据")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
            await store.fetchData(api: appState.apiClient)
            if let users = store.response?.users {
                expandedUsers = Set(users.map(\.userKey))
            }
        }
    }

    private func navigateToLogs(user: String, session: String) {
        let logsStore = appState.logsStore
        logsStore.user = user
        logsStore.session = session
        appState.selectedPage = .logs
        Task {
            await logsStore.fetchFirstPage(api: appState.apiClient)
        }
    }
}
