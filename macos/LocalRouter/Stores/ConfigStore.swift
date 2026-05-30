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

    func apply(api: APIClient) async throws {
        applying = true
        defer { applying = false }
        _ = try await api.applyConfig()
    }

    func saveAndApply(api: APIClient, overrideDraft: AppConfig? = nil) async throws {
        try await save(api: api, overrideDraft: overrideDraft)
        try await apply(api: api)
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
