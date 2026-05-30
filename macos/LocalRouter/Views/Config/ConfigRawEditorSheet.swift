import SwiftUI

struct ConfigRawEditorSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(ConfigStore.self) private var configStore
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var parseError: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                TextEditor(text: $text)
                    .font(.system(.body, design: .monospaced))
                    .onChange(of: text) { _, newValue in
                        validateJSON(newValue)
                    }

                if let error = parseError {
                    Divider()
                    HStack(spacing: 6) {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(.red)
                        Spacer()
                    }
                    .padding(.horizontal)
                    .padding(.vertical, 6)
                }
            }
            .navigationTitle("原始配置")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
                ToolbarItemGroup(placement: .automatic) {
                    Button("格式化") { formatJSON() }
                    Button("重置") { loadFromDraft() }
                    Button("应用到草稿") { applyToDraft() }
                        .disabled(parseError != nil)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存并应用") {
                        Task { await saveAndApply() }
                    }
                    .primaryActionStyle(enabled: parseError == nil)
                    .disabled(parseError != nil)
                }
            }
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
        do {
            let result = try await configStore.saveAndApply(api: appState.apiClient, overrideDraft: config)
            dismiss()
            configStore.handleApplyResult(result, successMessage: "配置已保存并应用")
        } catch {
            dismiss()
            configStore.showResult(success: false, message: error.localizedDescription)
        }
    }
}
