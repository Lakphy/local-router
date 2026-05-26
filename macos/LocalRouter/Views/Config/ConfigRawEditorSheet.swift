import SwiftUI

struct ConfigRawEditorSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(ConfigStore.self) private var configStore
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var parseError: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("原始配置")
                    .font(.headline)
                Spacer()

                if let error = parseError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }

                Button("关闭") { dismiss() }
                    .buttonStyle(.borderless)
            }
            .padding()

            Divider()

            TextEditor(text: $text)
                .font(.system(.body, design: .monospaced))
                .onChange(of: text) { _, newValue in
                    validateJSON(newValue)
                }

            Divider()

            HStack {
                Button("格式化") {
                    formatJSON()
                }
                .buttonStyle(.bordered)

                Button("重置") {
                    loadFromDraft()
                }
                .buttonStyle(.bordered)

                Spacer()

                Button("应用到草稿") {
                    applyToDraft()
                }
                .buttonStyle(.bordered)
                .disabled(parseError != nil)

                Button("保存并应用") {
                    Task {
                        await saveAndApply()
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(parseError != nil)
            }
            .padding()
        }
        .frame(minWidth: 600, minHeight: 400)
        .onAppear {
            loadFromDraft()
        }
    }

    private func loadFromDraft() {
        text = JSONPrettyPrint.formatCodable(configStore.draft ?? AppConfig(routes: OrderedMap(), providers: OrderedMap()))
        parseError = nil
    }

    private func validateJSON(_ json: String) {
        guard let data = json.data(using: .utf8) else {
            parseError = "无效的文本编码"
            return
        }
        do {
            _ = try JSONDecoder().decode(AppConfig.self, from: data)
            parseError = nil
        } catch {
            parseError = "JSON 解析错误"
        }
    }

    private func formatJSON() {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data),
              let prettyData = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]),
              let pretty = String(data: prettyData, encoding: .utf8) else { return }
        text = pretty
    }

    private func applyToDraft() {
        guard let data = text.data(using: .utf8),
              let config = try? JSONDecoder().decode(AppConfig.self, from: data) else { return }
        configStore.updateDraft { $0 = config }
        dismiss()
    }

    private func saveAndApply() async {
        guard let data = text.data(using: .utf8),
              let config = try? JSONDecoder().decode(AppConfig.self, from: data) else { return }
        try? await configStore.saveAndApply(api: appState.apiClient, overrideDraft: config)
        dismiss()
    }
}
