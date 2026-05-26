import SwiftUI

struct ProvidersPage: View {
    @Environment(AppState.self) private var appState
    @Environment(ConfigStore.self) private var configStore
    @State private var selectedProvider: String?
    @State private var showAddSheet = false
    @State private var newProviderName = ""
    @State private var showDeleteAlert = false
    @State private var providerToDelete = ""
    @State private var orderedNames: [String] = []

    private var draftProviders: OrderedMap<ProviderConfig> {
        configStore.draft?.providers ?? OrderedMap<ProviderConfig>()
    }

    var body: some View {
        HSplitView {
            // Left: provider list
            VStack(spacing: 0) {
                List(selection: $selectedProvider) {
                    ForEach(orderedNames, id: \.self) { name in
                        if let provider = draftProviders[name] {
                            ProviderCard(name: name, provider: provider)
                                .tag(name)
                                .listRowInsets(EdgeInsets(top: 3, leading: 4, bottom: 3, trailing: 4))
                                .contextMenu {
                                    Button {
                                        duplicateProvider(name)
                                    } label: {
                                        Label("复制", systemImage: "doc.on.doc")
                                    }

                                    Divider()

                                    Button(role: .destructive) {
                                        providerToDelete = name
                                        showDeleteAlert = true
                                    } label: {
                                        Label("删除", systemImage: "trash")
                                    }
                                }
                        }
                    }
                    .onMove { from, to in
                        orderedNames.move(fromOffsets: from, toOffset: to)
                        writeDraftFromOrder()
                    }
                }
                .listStyle(.inset)

                Divider()

                Button {
                    showAddSheet = true
                } label: {
                    HStack {
                        Image(systemName: "plus")
                            .font(.caption)
                        Text("添加服务商")
                            .font(.caption)
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .padding(8)
            }
            .frame(minWidth: 180, idealWidth: 220, maxWidth: 280)

            // Right: provider form
            if let name = selectedProvider, let provider = draftProviders[name] {
                ProviderFormView(
                    name: name,
                    provider: provider,
                    onUpdate: { updated in
                        configStore.updateDraft { $0.providers[name] = updated }
                    }
                )
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "server.rack")
                        .font(.system(size: 32))
                        .foregroundStyle(.tertiary)
                    Text(orderedNames.isEmpty
                         ? "点击下方按钮添加服务商"
                         : "选择一个服务商")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear {
            syncOrderedNames()
        }
        .onChange(of: configStore.draft?.providers.keys.sorted()) { _, _ in
            syncOrderedNames()
        }
        .alert("确认删除", isPresented: $showDeleteAlert) {
            Button("取消", role: .cancel) {}
            Button("删除", role: .destructive) {
                deleteProvider(providerToDelete)
            }
        } message: {
            Text("确定要删除服务商「\(providerToDelete)」吗？引用此服务商的路由规则将失效。")
        }
        .sheet(isPresented: $showAddSheet) {
            VStack(spacing: 16) {
                Text("添加服务商")
                    .font(.headline)
                TextField("名称", text: $newProviderName)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 200)
                HStack {
                    Button("取消") { showAddSheet = false }
                        .buttonStyle(.bordered)
                    Button("添加") {
                        addProvider(name: newProviderName)
                        showAddSheet = false
                        newProviderName = ""
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(newProviderName.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .padding(24)
        }
    }

    private func syncOrderedNames() {
        let currentKeys = draftProviders.keys
        let existingSet = Set(orderedNames)
        let existingOrdered = orderedNames.filter { currentKeys.contains($0) }
        let newKeys = currentKeys.filter { !existingSet.contains($0) }
        orderedNames = existingOrdered + newKeys
    }

    private func writeDraftFromOrder() {
        let providers = draftProviders
        var reordered = OrderedMap<ProviderConfig>()
        for name in orderedNames {
            if let p = providers[name] {
                reordered[name] = p
            }
        }
        configStore.updateDraft { $0.providers = reordered }
    }

    private func addProvider(name: String) {
        let provider = ProviderConfig(
            type: .openaiCompletions,
            base: "",
            apiKey: "",
            models: [:]
        )
        configStore.updateDraft { $0.providers[name] = provider }
        orderedNames.append(name)
        selectedProvider = name
    }

    private func duplicateProvider(_ name: String) {
        guard let provider = draftProviders[name] else { return }
        let newName = "\(name)-copy"
        configStore.updateDraft { $0.providers[newName] = provider }
        if let idx = orderedNames.firstIndex(of: name) {
            orderedNames.insert(newName, at: idx + 1)
        } else {
            orderedNames.append(newName)
        }
        selectedProvider = newName
    }

    private func deleteProvider(_ name: String) {
        configStore.updateDraft { $0.providers.removeValue(forKey: name) }
        orderedNames.removeAll { $0 == name }
        if selectedProvider == name {
            selectedProvider = orderedNames.first
        }
    }
}

// MARK: - Provider Card

private struct ProviderCard: View {
    let name: String
    let provider: ProviderConfig

    var body: some View {
        HStack(spacing: 8) {
            // Drag handle - 6 dots (2x3 grid)
            VStack(spacing: 2) {
                ForEach(0..<3, id: \.self) { _ in
                    HStack(spacing: 2) {
                        Circle().frame(width: 3, height: 3)
                        Circle().frame(width: 3, height: 3)
                    }
                }
            }
            .foregroundStyle(.quaternary)

            VStack(alignment: .leading, spacing: 4) {
                Text(name)
                    .font(.system(.subheadline, weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.tail)

                HStack(spacing: 8) {
                    Text(provider.type.displayName)
                        .font(.caption2)
                        .foregroundStyle(.secondary)

                    Text("·")
                        .foregroundStyle(.quaternary)

                    Text("\(provider.models.count) 个模型")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
    }
}
