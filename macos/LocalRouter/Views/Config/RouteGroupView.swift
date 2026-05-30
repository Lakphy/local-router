import SwiftUI

struct RouteGroupView: View {
    let routeType: String
    let rules: OrderedMap<RouteTarget>
    let onUpdate: (OrderedMap<RouteTarget>) -> Void
    @Environment(ConfigStore.self) private var configStore

    private var specificRules: [(key: String, target: RouteTarget)] {
        rules.filter { key, _ in key != "*" }
            .map { (key: $0.key, target: $0.value) }
    }

    private var wildcardRule: RouteTarget? {
        rules["*"]
    }

    private var providers: OrderedMap<ProviderConfig> {
        configStore.draft?.providers ?? OrderedMap<ProviderConfig>()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Column header
            HStack(spacing: 0) {
                Text("请求模型")
                    .frame(width: 160, alignment: .leading)
                Spacer().frame(width: 24)
                Text("路由目标")
                Spacer()
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.leading, 16)
            .padding(.bottom, 6)

            // Specific rules
            ForEach(specificRules, id: \.key) { entry in
                RuleRow(
                    ruleKey: entry.key,
                    target: entry.target,
                    isWildcard: false,
                    providers: providers,
                    onKeyCommit: { newKey in
                        updateRuleKey(oldKey: entry.key, newKey: newKey)
                    },
                    onTargetChange: { field, value in
                        updateRuleTarget(key: entry.key, field: field, value: value)
                    },
                    onRemove: {
                        removeRule(key: entry.key)
                    }
                )
            }

            // Fallback separator
            if wildcardRule != nil && !specificRules.isEmpty {
                HStack(spacing: 8) {
                    VStack { Divider() }
                    Text("兜底规则 — 未匹配的请求将路由至此")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize()
                    VStack { Divider() }
                }
                .padding(.leading, 16)
                .padding(.vertical, 6)
            }

            // Wildcard rule
            if let target = wildcardRule {
                RuleRow(
                    ruleKey: "*",
                    target: target,
                    isWildcard: true,
                    providers: providers,
                    onKeyCommit: { _ in },
                    onTargetChange: { field, value in
                        updateRuleTarget(key: "*", field: field, value: value)
                    },
                    onRemove: {}
                )
            }
        }
    }

    private func removeRule(key: String) {
        guard key != "*" else { return }
        var r = rules
        r.removeValue(forKey: key)
        onUpdate(r)
    }

    private func updateRuleKey(oldKey: String, newKey: String) {
        guard newKey != oldKey, !newKey.isEmpty else { return }
        var ordered = OrderedMap<RouteTarget>()
        for key in rules.keys {
            let newKeyName = (key == oldKey) ? newKey : key
            if let v = rules[key] {
                ordered[newKeyName] = v
            }
        }
        onUpdate(ordered)
    }

    private func updateRuleTarget(key: String, field: String, value: String) {
        var r = rules
        guard var target = r[key] else { return }
        if field == "provider" {
            target.provider = value
        } else {
            target.model = value
        }
        r[key] = target
        onUpdate(r)
    }
}

// MARK: - Rule Row

private struct RuleRow: View {
    let ruleKey: String
    let target: RouteTarget
    let isWildcard: Bool
    let providers: OrderedMap<ProviderConfig>
    let onKeyCommit: (String) -> Void
    let onTargetChange: (String, String) -> Void
    let onRemove: () -> Void

    @State private var draftKey: String = ""
    @FocusState private var keyFieldFocused: Bool

    private var groupedProviders: [(type: ProviderType, names: [String])] {
        ProviderType.allCases.compactMap { type in
            let names = providers.filter { _, v in v.type == type }.map(\.key)
            return names.isEmpty ? nil : (type: type, names: names)
        }
    }

    private var availableModels: [String] {
        guard let p = providers[target.provider] else { return [] }
        return Array(p.models.keys).sorted()
    }

    var body: some View {
        HStack(spacing: 0) {
            // Branch connector
            BranchConnector()
                .frame(width: 16, height: 20)

            // Rule card
            HStack(spacing: 6) {
                // Model pattern (left)
                if isWildcard {
                    HStack(spacing: DS.gapXS) {
                        StatusBadge("*", color: .secondary)
                        Text("所有")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .frame(width: 160, alignment: .leading)
                } else {
                    TextField("模型别名", text: $draftKey)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                        .frame(width: 160)
                        .focused($keyFieldFocused)
                        .onSubmit { commitKey() }
                        .onChange(of: keyFieldFocused) { _, focused in
                            if !focused { commitKey() }
                        }
                }

                // Arrow
                Image(systemName: "arrow.right")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .frame(width: 20)

                // Provider picker (grouped by type)
                Picker("", selection: Binding(
                    get: { target.provider },
                    set: { onTargetChange("provider", $0) }
                )) {
                    Text("选择服务商...").tag("")
                    ForEach(groupedProviders, id: \.type) { group in
                        Section(group.type.displayName) {
                            ForEach(group.names, id: \.self) { name in
                                Text(name).tag(name)
                            }
                        }
                    }
                }
                .labelsHidden()
                .frame(minWidth: 140, maxWidth: 200)

                Text("/")
                    .font(.caption)
                    .foregroundStyle(.tertiary)

                // Model picker or text field
                if availableModels.isEmpty {
                    TextField("模型名称", text: Binding(
                        get: { target.model },
                        set: { onTargetChange("model", $0) }
                    ))
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.caption, design: .monospaced))
                    .frame(minWidth: 100)
                } else {
                    Picker("", selection: Binding(
                        get: { target.model },
                        set: { onTargetChange("model", $0) }
                    )) {
                        Text("选择模型...").tag("")
                        ForEach(availableModels, id: \.self) { m in
                            Text(m).tag(m)
                        }
                    }
                    .labelsHidden()
                    .frame(minWidth: 100)
                }

                Spacer(minLength: 0)

                // Delete button
                Button {
                    onRemove()
                } label: {
                    Image(systemName: "trash")
                        .font(.caption2)
                        .foregroundStyle(isWildcard ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.red))
                }
                .buttonStyle(.borderless)
                .disabled(isWildcard)
            }
            .padding(.horizontal, DS.gapS)
            .padding(.vertical, 6)
            .ruleRowSurface(wildcard: isWildcard)
        }
        .padding(.vertical, 2)
        .onAppear {
            draftKey = ruleKey
        }
        .onChange(of: ruleKey) { _, newVal in
            draftKey = newVal
        }
    }

    private func commitKey() {
        let trimmed = draftKey.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty && trimmed != ruleKey {
            onKeyCommit(trimmed)
        } else {
            draftKey = ruleKey
        }
    }
}

// MARK: - Branch Connector

private struct BranchConnector: View {
    var body: some View {
        Canvas { context, size in
            let path = Path { p in
                p.move(to: CGPoint(x: 1, y: 0))
                p.addQuadCurve(
                    to: CGPoint(x: size.width, y: size.height / 2),
                    control: CGPoint(x: 1, y: size.height / 2)
                )
            }
            context.stroke(path, with: .color(Color(nsColor: .separatorColor)), lineWidth: 1)
        }
    }
}
