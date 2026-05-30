import SwiftUI

struct RoutesEditorView: View {
    /// When true, prevents the first model-alias TextField from grabbing the
    /// window's initial first responder (used on the dashboard homepage).
    var disableInitialFocus = false

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
        VStack(alignment: .leading, spacing: 16) {
            if routeTypes.isEmpty {
                ContentUnavailableView(
                    "暂无路由配置",
                    systemImage: "arrow.triangle.branch",
                    description: Text("请先在下方添加一个协议入口")
                )
                .frame(height: 200)
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
                    .secondaryActionStyle()
                    .disabled(newRouteType.isEmpty)
                }
            }
        }
        .alert("确认删除", isPresented: $showDeleteAlert) {
            Button("取消", role: .cancel) {}
            Button("删除", role: .destructive) {
                configStore.updateDraft { $0.routes.removeValue(forKey: routeTypeToDelete) }
            }
        } message: {
            Text("确定要删除协议入口「\(routeTypeToDelete)」及其所有路由规则吗？")
        }
        .background {
            if disableInitialFocus {
                InitialFocusClearer()
            }
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
            .cardSurface(cornerRadius: DS.controlRadius)

            // Rules area with left connector line
            if !rules.isEmpty {
                HStack(alignment: .top, spacing: 0) {
                    Rectangle()
                        .fill(.separator)
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
