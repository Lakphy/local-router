import Foundation

@Observable
final class ConfigStore {
    var config: AppConfig?
    var draft: AppConfig?
    var loading = true
    var saving = false
    var applying = false
    var error: String?
    var showDiffSheet = false
    var showRawEditor = false
    var diffMode: DiffMode = .view

    var showResultAlert = false
    var resultAlertSuccess = true
    var resultAlertMessage = ""

    // 重启确认（监听地址变更后需要重启服务才能生效）
    var showRestartAlert = false
    var restartListenHost = ""
    var restartListenPort = 0

    enum DiffMode {
        case view
        case save
        case saveAndApply
    }

    var isDirty: Bool {
        guard let config, let draft else { return false }
        return config != draft
    }

    func loadConfig(api: APIClient) async {
        loading = true
        error = nil
        do {
            let loaded = try await api.fetchConfig()
            config = loaded
            draft = loaded
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    func updateDraft(_ updater: (inout AppConfig) -> Void) {
        guard var d = draft else { return }
        updater(&d)
        draft = d
    }

    func save(api: APIClient, overrideDraft: AppConfig? = nil) async throws {
        let configToSave = overrideDraft ?? draft
        guard let configToSave else { return }
        saving = true
        defer { saving = false }
        try await api.saveConfig(configToSave)
        config = configToSave
        draft = configToSave
    }

    @discardableResult
    func apply(api: APIClient) async throws -> ApplyResult {
        applying = true
        defer { applying = false }
        return try await api.applyConfig()
    }

    @discardableResult
    func saveAndApply(api: APIClient, overrideDraft: AppConfig? = nil) async throws -> ApplyResult {
        try await save(api: api, overrideDraft: overrideDraft)
        return try await apply(api: api)
    }

    /// apply 后若监听地址变更，处理重启提示/结果展示。
    func handleApplyResult(_ result: ApplyResult, successMessage: String) {
        guard result.restartRequired else {
            showResult(success: true, message: successMessage)
            return
        }
        if result.canRestart {
            restartListenHost = result.listenHost ?? ""
            restartListenPort = result.listenPort ?? 0
            showRestartAlert = true
        } else {
            showResult(
                success: true,
                message: "配置已保存并应用，但监听地址变更需手动重启服务（local-router restart）后生效"
            )
        }
    }

    func showResult(success: Bool, message: String) {
        resultAlertSuccess = success
        resultAlertMessage = message
        showResultAlert = true
    }

    func reset() {
        draft = config
    }

    func resetAll() {
        config = nil
        draft = nil
        loading = true
        error = nil
    }
}
