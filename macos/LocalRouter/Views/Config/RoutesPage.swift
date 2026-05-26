import SwiftUI

struct RoutesPage: View {
    @Environment(ConfigStore.self) private var configStore
    @State private var newRouteType = ""
    @State private var showDeleteAlert = false
    @State private var routeTypeToDelete = ""

    private var routeTypes: [String] {
        guard let routes = configStore.draft?.routes else { return [] }
        return routes.keys
    }

    private var availableRouteTypes: [String] {
        let existing = Set(routeTypes)
        return ProviderType.allCases.map(\.rawValue).filter { !existing.contains($0) }
    }

    private var defaultTarget: RouteTarget {
        guard let providers = configStore.draft?.providers else {
            return RouteTarget(provider: "", model: "")
        }
        let firstProvider = providers.keys.sorted().first ?? ""
        let firstModel = firstProvider.isEmpty ? "" :
            (providers[firstProvider]?.models.keys.sorted().first ?? "")
        return RouteTarget(provider: firstProvider, model: firstModel)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("路由")
                        .font(.title2)
                        .fontWeight(.semibold)
                    Text("管理协议入口与模型路由映射")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                if routeTypes.isEmpty {
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color.gray.opacity(0.3), lineWidth: 1)
                        .frame(height: 120)
                        .overlay {
                            Text("暂无路由配置，请先添加一个协议入口")
                                .foregroundStyle(.secondary)
                        }
                } else {
                    VStack(alignment: .leading, spacing: 24) {
                        ForEach(routeTypes, id: \.self) { routeType in
                            routeTypeSection(routeType)
                        }
                    }
                }

                if !availableRouteTypes.isEmpty {
                    HStack(spacing: 8) {
                        Picker("协议类型", selection: $newRouteType) {
                            Text("选择协议类型...").tag("")
                            ForEach(availableRouteTypes, id: \.self) { type in
                                Text(type).tag(type)
                            }
                        }
                        .labelsHidden()
                        .frame(width: 240)

                        Button {
                            addRouteType()
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "plus")
                                    .font(.caption)
                                Text("添加协议入口")
                            }
                        }
                        .buttonStyle(.bordered)
                        .disabled(newRouteType.isEmpty)
                    }
                }
            }
            .padding()
        }
        .alert("确认删除", isPresented: $showDeleteAlert) {
            Button("取消", role: .cancel) {}
            Button("删除", role: .destructive) {
                configStore.updateDraft { $0.routes.removeValue(forKey: routeTypeToDelete) }
            }
        } message: {
            Text("确定要删除协议入口「\(routeTypeToDelete)」及其所有路由规则吗？")
        }
    }

    @ViewBuilder
    private func routeTypeSection(_ routeType: String) -> some View {
        let rules = configStore.draft?.routes[routeType] ?? OrderedMap<RouteTarget>()
        let ruleCount = rules.count

        VStack(alignment: .leading, spacing: 0) {
            // Header card
            HStack {
                HStack(spacing: 8) {
                    Text(routeType)
                        .font(.system(.subheadline, weight: .semibold))
                    StatusBadge("\(ruleCount) 个规则", color: .blue)
                }

                Spacer()

                HStack(spacing: 6) {
                    Button {
                        addRule(routeType)
                    } label: {
                        HStack(spacing: 3) {
                            Image(systemName: "plus")
                                .font(.caption2)
                            Text("添加规则")
                                .font(.caption)
                        }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)

                    Button {
                        routeTypeToDelete = routeType
                        showDeleteAlert = true
                    } label: {
                        Image(systemName: "trash")
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                    .buttonStyle(.borderless)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background {
                RoundedRectangle(cornerRadius: 8)
                    .fill(.background)
                    .stroke(Color.gray.opacity(0.3), lineWidth: 1)
            }

            // Rules area with left connector line
            if !rules.isEmpty {
                HStack(alignment: .top, spacing: 0) {
                    // Vertical connector line
                    Rectangle()
                        .fill(Color.gray.opacity(0.3))
                        .frame(width: 1)
                        .padding(.leading, 12)

                    VStack(alignment: .leading, spacing: 0) {
                        RouteGroupView(
                            routeType: routeType,
                            rules: rules,
                            onUpdate: { newRules in
                                configStore.updateDraft { $0.routes[routeType] = newRules }
                            }
                        )
                    }
                    .padding(.leading, 4)
                }
                .padding(.top, 4)
            }
        }
    }

    private func addRouteType() {
        guard !newRouteType.isEmpty else { return }
        let target = defaultTarget
        var rules = OrderedMap<RouteTarget>()
        rules["*"] = target
        configStore.updateDraft {
            $0.routes[newRouteType] = rules
        }
        newRouteType = ""
    }

    private func addRule(_ routeType: String) {
        let target = defaultTarget
        let alias = "alias-\(Int(Date().timeIntervalSince1970 * 1000))"
        configStore.updateDraft {
            $0.routes[routeType]?[alias] = target
        }
    }
}
