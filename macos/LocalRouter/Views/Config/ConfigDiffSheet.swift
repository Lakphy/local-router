import SwiftUI

struct ConfigDiffSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(ConfigStore.self) private var configStore
    @Environment(\.dismiss) private var dismiss
    @State private var diffLines: [DiffLine]?

    var body: some View {
        NavigationStack {
            Group {
                if let diffLines {
                    if diffLines.allSatisfy({ $0.kind == .unchanged }) {
                        ContentUnavailableView(
                            "没有更改",
                            systemImage: "checkmark.circle",
                            description: Text("当前草稿与已保存配置一致")
                        )
                    } else {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 0) {
                                ForEach(diffLines) { line in
                                    HStack(spacing: 0) {
                                        Text(linePrefix(line))
                                            .font(.system(.caption2, design: .monospaced))
                                            .foregroundStyle(.secondary)
                                            .frame(width: 60, alignment: .trailing)
                                            .padding(.trailing, 8)

                                        Text(line.text)
                                            .font(.system(.caption, design: .monospaced))
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                            .textSelection(.enabled)
                                    }
                                    .padding(.vertical, 1)
                                    .padding(.horizontal, 8)
                                    .background(lineBackground(line))
                                }
                            }
                        }
                        .contentScroll()
                    }
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle("配置差异")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if configStore.diffMode == .save {
                        Button("保存") {
                            Task {
                                do {
                                    try await configStore.save(api: appState.apiClient)
                                    dismiss()
                                    configStore.showResult(success: true, message: "配置已保存")
                                } catch {
                                    dismiss()
                                    configStore.showResult(success: false, message: error.localizedDescription)
                                }
                            }
                        }
                        .primaryActionStyle()
                    } else if configStore.diffMode == .saveAndApply {
                        Button("保存并应用") {
                            Task {
                                do {
                                    let result = try await configStore.saveAndApply(api: appState.apiClient)
                                    dismiss()
                                    configStore.handleApplyResult(result, successMessage: "配置已保存并应用")
                                } catch {
                                    dismiss()
                                    configStore.showResult(success: false, message: error.localizedDescription)
                                }
                            }
                        }
                        .primaryActionStyle()
                    }
                }
            }
        }
        .frame(minWidth: 600, minHeight: 400)
        .task {
            let oldJSON = JSONPrettyPrint.formatCodable(configStore.config ?? AppConfig(routes: OrderedMap(), providers: OrderedMap()))
            let newJSON = JSONPrettyPrint.formatCodable(configStore.draft ?? AppConfig(routes: OrderedMap(), providers: OrderedMap()))
            let result = await Task.detached(priority: .userInitiated) {
                DiffEngine.computeDiff(old: oldJSON, new: newJSON)
            }.value
            diffLines = result
        }
    }

    private func linePrefix(_ line: DiffLine) -> String {
        switch line.kind {
        case .unchanged:
            let old = line.oldLineNumber.map { "\($0)" } ?? ""
            let new = line.newLineNumber.map { "\($0)" } ?? ""
            return "\(old)|\(new)"
        case .removed:
            return "\(line.oldLineNumber ?? 0)|-"
        case .added:
            return "-|\(line.newLineNumber ?? 0)"
        }
    }

    private func lineBackground(_ line: DiffLine) -> Color {
        switch line.kind {
        case .unchanged: .clear
        case .added: .green.opacity(0.1)
        case .removed: .red.opacity(0.1)
        }
    }
}
