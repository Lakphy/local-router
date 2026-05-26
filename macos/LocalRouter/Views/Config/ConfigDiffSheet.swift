import SwiftUI

struct ConfigDiffSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(ConfigStore.self) private var configStore
    @Environment(\.dismiss) private var dismiss
    @State private var diffLines: [DiffLine]?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("配置差异")
                    .font(.headline)
                Spacer()
                Button("关闭") { dismiss() }
                    .buttonStyle(.borderless)
            }
            .padding()

            Divider()

            if let diffLines {
                if diffLines.allSatisfy({ $0.kind == .unchanged }) {
                    VStack(spacing: 8) {
                        Image(systemName: "checkmark.circle")
                            .font(.largeTitle)
                            .foregroundStyle(.green)
                        Text("没有更改")
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
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
                }
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            Divider()

            HStack {
                Spacer()
                if configStore.diffMode == .save {
                    Button("保存") {
                        Task {
                            try? await configStore.save(api: appState.apiClient)
                            dismiss()
                        }
                    }
                    .buttonStyle(.borderedProminent)
                } else if configStore.diffMode == .saveAndApply {
                    Button("保存并应用") {
                        Task {
                            try? await configStore.saveAndApply(api: appState.apiClient)
                            dismiss()
                        }
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
            .padding()
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
