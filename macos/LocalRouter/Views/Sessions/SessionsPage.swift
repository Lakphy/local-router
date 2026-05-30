import SwiftUI

struct SessionsPage: View {
    @Environment(AppState.self) private var appState
    @Environment(SessionsStore.self) private var store
    @State private var expandedUsers: Set<String> = []

    var body: some View {
        @Bindable var store = store

        VStack(spacing: 0) {
            // Filters
            HStack(spacing: 12) {
                Picker("时间窗口", selection: $store.window) {
                    ForEach(LogQueryWindow.allCases, id: \.self) { w in
                        Text(w.displayName).tag(w)
                    }
                }
                .frame(width: 160)

                TextField("用户", text: $store.user)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 120)

                TextField("关键字", text: $store.keyword)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 120)

                Spacer()

                if store.loading {
                    ProgressView()
                        .controlSize(.small)
                }

                Button("查询") {
                    Task { await store.fetchData(api: appState.apiClient) }
                }
                .secondaryActionStyle()
                .keyboardShortcut(.return, modifiers: [])
                .disabled(store.loading)
            }
            .padding(.horizontal)
            .padding(.vertical, 8)

            // Summary
            if let summary = store.response?.summary {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 4), spacing: 6) {
                    StatBoxView("总请求", value: Formatters.formatNumber(summary.totalRequests))
                    StatBoxView("元数据请求", value: Formatters.formatNumber(summary.metadataRequests))
                    StatBoxView("独立用户", value: Formatters.formatNumber(summary.uniqueUsers))
                    StatBoxView("独立会话", value: Formatters.formatNumber(summary.uniqueSessions))
                }
                .padding(.horizontal)
                .padding(.bottom, 8)
            }

            Divider()

            content
        }
        .task {
            await store.fetchData(api: appState.apiClient)
            if let users = store.response?.users {
                expandedUsers = Set(users.map(\.userKey))
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let users = store.response?.users, !users.isEmpty {
            // Keep showing existing data while a refetch is in flight (no blocking
            // spinner) — the sessions query is server-side expensive, so a full-screen
            // ProgressView on every visit makes the page feel frozen.
            List {
                ForEach(users) { user in
                    DisclosureGroup(isExpanded: expansionBinding(user.userKey)) {
                        ForEach(user.sessions) { session in
                            sessionRow(user: user, session: session)
                        }
                    } label: {
                        userRow(user)
                    }
                }
            }
            .listStyle(.inset)
            .contentScroll()
        } else if store.loading {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ContentUnavailableView(
                "暂无用户会话数据",
                systemImage: "person.2",
                description: Text("调整筛选条件后点击查询")
            )
        }
    }

    private func userRow(_ user: LogUserSummary) -> some View {
        HStack {
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
        .padding(.vertical, 2)
    }

    private func sessionRow(user: LogUserSummary, session: LogSessionSummary) -> some View {
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
        .padding(.vertical, 2)
    }

    private func expansionBinding(_ key: String) -> Binding<Bool> {
        Binding(
            get: { expandedUsers.contains(key) },
            set: { isExpanded in
                if isExpanded {
                    expandedUsers.insert(key)
                } else {
                    expandedUsers.remove(key)
                }
            }
        )
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
