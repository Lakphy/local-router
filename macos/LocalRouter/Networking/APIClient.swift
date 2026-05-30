import Foundation

enum APIError: LocalizedError {
    case invalidURL
    case notConnected
    case httpError(status: Int, message: String?)
    case decodingError(Error)
    case cryptoHandshakeFailed
    case unknown(Error)

    var errorDescription: String? {
        switch self {
        case .invalidURL: "无效的 URL"
        case .notConnected: "未连接到服务器"
        case .httpError(let status, let message): message ?? "HTTP 错误: \(status)"
        case .decodingError(let error): "数据解析错误: \(error.localizedDescription)"
        case .cryptoHandshakeFailed: "加密握手失败"
        case .unknown(let error): error.localizedDescription
        }
    }
}

@Observable
final class APIClient {
    var baseURL: URL?
    private let session: URLSession
    private let decoder: JSONDecoder

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 60
        self.session = URLSession(configuration: config)
        self.decoder = JSONDecoder()
    }

    // MARK: - Health

    func checkHealth() async -> Bool {
        guard let url = makeURL("/api/health") else { return false }
        do {
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return false }
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                return json["status"] as? String == "ok"
            }
            return false
        } catch {
            return false
        }
    }

    // MARK: - Config (Encrypted)

    func fetchConfig() async throws -> AppConfig {
        try await withOneShotSession { client, sessionId in
            guard let url = self.makeURL("/api/config") else { throw APIError.invalidURL }
            var request = URLRequest(url: url)
            request.setValue(sessionId, forHTTPHeaderField: "x-crypto-session")

            let (data, response) = try await self.session.data(for: request)
            try self.checkHTTPResponse(response)

            let encrypted = try self.decoder.decode(EncryptedPayload.self, from: data)
            let decrypted = try client.decrypt(encrypted)
            guard let configData = decrypted.data(using: .utf8) else { throw APIError.decodingError(CryptoError.decryptionFailed) }
            return try self.decoder.decode(AppConfig.self, from: configData)
        }
    }

    func saveConfig(_ config: AppConfig) async throws {
        try await withOneShotSession { client, sessionId in
            guard let url = self.makeURL("/api/config") else { throw APIError.invalidURL }
            let configJSON = try OrderedJSONEncoder.encode(config)
            guard let configString = String(data: configJSON, encoding: .utf8) else { throw APIError.unknown(CryptoError.encryptionFailed) }

            let encrypted = try client.encrypt(configString)
            let body = try JSONEncoder().encode(encrypted)

            var request = URLRequest(url: url)
            request.httpMethod = "PUT"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(sessionId, forHTTPHeaderField: "x-crypto-session")
            request.httpBody = body

            let (_, response) = try await self.session.data(for: request)
            try self.checkHTTPResponse(response)
        }
    }

    func applyConfig() async throws -> (providers: Int, routes: Int) {
        guard let url = makeURL("/api/config/apply") else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"

        let (data, response) = try await session.data(for: request)
        try checkHTTPResponse(response)

        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let summary = json?["summary"] as? [String: Any]
        return (
            providers: summary?["providers"] as? Int ?? 0,
            routes: summary?["routes"] as? Int ?? 0
        )
    }

    func fetchConfigMeta() async throws -> ConfigMeta {
        try await get("/api/config/meta")
    }

    func fetchConfigSchema() async throws -> [String: Any] {
        guard let url = makeURL("/api/config/schema") else { throw APIError.invalidURL }
        let (data, response) = try await session.data(from: url)
        try checkHTTPResponse(response)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw APIError.decodingError(NSError(domain: "", code: 0, userInfo: [NSLocalizedDescriptionKey: "Invalid JSON"]))
        }
        return json
    }

    // MARK: - Autostart

    func fetchAutostartStatus() async throws -> AutostartStatus {
        try await get("/api/autostart")
    }

    func setAutostart(enabled: Bool) async throws {
        guard let url = makeURL("/api/autostart") else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["enabled": enabled])

        let (_, response) = try await session.data(for: request)
        try checkHTTPResponse(response)
    }

    // MARK: - Metrics

    func fetchLogMetrics(window: MetricsWindow = .twentyFourHours, refresh: Bool = false) async throws -> LogMetricsResponse {
        var params = "window=\(window.rawValue)"
        if refresh { params += "&refresh=1" }
        return try await get("/api/metrics/logs?\(params)")
    }

    func fetchLogStorage(refresh: Bool = false) async throws -> LogStorageInfo {
        let params = refresh ? "refresh=1" : "refresh=0"
        return try await get("/api/logs/storage?\(params)")
    }

    // MARK: - Log Events

    func fetchLogEvents(params: LogQueryParams = .init()) async throws -> LogEventsResponse {
        let query = params.toQueryString()
        let path = query.isEmpty ? "/api/logs/events" : "/api/logs/events?\(query)"
        return try await get(path)
    }

    func fetchLogEventDetail(id: String) async throws -> LogEventDetail {
        let encodedId = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        return try await get("/api/logs/events/\(encodedId)")
    }

    func exportLogEvents(params: LogQueryParams, format: ExportFormat) async throws -> Data {
        var query = params.toQueryString()
        let formatParam = "format=\(format.rawValue)"
        query = query.isEmpty ? formatParam : "\(formatParam)&\(query)"

        guard let url = makeURL("/api/logs/export?\(query)") else { throw APIError.invalidURL }
        let (data, response) = try await session.data(from: url)
        try checkHTTPResponse(response)
        return data
    }

    // MARK: - Sessions

    func fetchLogSessions(params: SessionQueryParams = .init()) async throws -> LogSessionsResponse {
        let query = params.toQueryString()
        let path = query.isEmpty ? "/api/logs/sessions" : "/api/logs/sessions?\(query)"
        return try await get(path)
    }

    // MARK: - Private Helpers

    private func makeURL(_ path: String) -> URL? {
        guard let baseURL else { return nil }
        return URL(string: path, relativeTo: baseURL)
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        guard let url = makeURL(path) else { throw APIError.invalidURL }
        let (data, response) = try await session.data(from: url)
        try checkHTTPResponse(response)
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decodingError(error)
        }
    }

    private func checkHTTPResponse(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200...299).contains(http.statusCode) else {
            throw APIError.httpError(status: http.statusCode, message: nil)
        }
    }

    private func withOneShotSession<T>(_ action: (CryptoClient, String) async throws -> T) async throws -> T {
        let session = try await createOneShotSession()
        return try await action(session.client, session.sessionId)
    }

    private struct OneShotSession {
        let client: CryptoClient
        let sessionId: String
    }

    private func createOneShotSession() async throws -> OneShotSession {
        let client = CryptoClient()
        let clientPublicKey = client.publicKeyBase64

        guard let url = makeURL("/api/crypto/handshake") else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["clientPublicKey": clientPublicKey])

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw APIError.cryptoHandshakeFailed
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let serverPublicKey = json["serverPublicKey"] as? String,
              let sessionId = json["sessionId"] as? String else {
            throw APIError.cryptoHandshakeFailed
        }

        try client.deriveKey(serverPublicKeyBase64: serverPublicKey)
        return OneShotSession(client: client, sessionId: sessionId)
    }
}

// MARK: - Query Params

struct LogQueryParams {
    var window: LogQueryWindow?
    var from: String?
    var to: String?
    var levels: [LogLevel]?
    var provider: String?
    var routeType: String?
    var model: String?
    var modelIn: String?
    var modelOut: String?
    var user: String?
    var session: String?
    var statusClass: [StatusClass]?
    var hasError: Bool?
    var q: String?
    var sort: SortOrder?
    var limit: Int?
    var cursor: String?

    enum SortOrder: String {
        case timeDesc = "time_desc"
        case timeAsc = "time_asc"
    }

    func toQueryString() -> String {
        var parts: [String] = []
        if let window { parts.append("window=\(window.rawValue)") }
        if let from { parts.append("from=\(from)") }
        if let to { parts.append("to=\(to)") }
        if let levels, !levels.isEmpty { parts.append("levels=\(levels.map(\.rawValue).joined(separator: ","))") }
        if let provider, !provider.isEmpty { parts.append("provider=\(provider)") }
        if let routeType, !routeType.isEmpty { parts.append("routeType=\(routeType)") }
        if let model, !model.isEmpty { parts.append("model=\(model)") }
        if let modelIn, !modelIn.isEmpty { parts.append("modelIn=\(modelIn)") }
        if let modelOut, !modelOut.isEmpty { parts.append("modelOut=\(modelOut)") }
        if let user, !user.isEmpty { parts.append("user=\(user)") }
        if let session, !session.isEmpty { parts.append("session=\(session)") }
        if let statusClass, !statusClass.isEmpty { parts.append("statusClass=\(statusClass.map(\.rawValue).joined(separator: ","))") }
        if let hasError { parts.append("hasError=\(hasError ? "true" : "false")") }
        if let q, !q.isEmpty { parts.append("q=\(q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q)") }
        if let sort { parts.append("sort=\(sort.rawValue)") }
        if let limit { parts.append("limit=\(limit)") }
        if let cursor { parts.append("cursor=\(cursor.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? cursor)") }
        return parts.joined(separator: "&")
    }
}

struct SessionQueryParams {
    var window: LogQueryWindow?
    var from: String?
    var to: String?
    var user: String?
    var session: String?
    var q: String?

    func toQueryString() -> String {
        var parts: [String] = []
        if let window { parts.append("window=\(window.rawValue)") }
        if let from { parts.append("from=\(from)") }
        if let to { parts.append("to=\(to)") }
        if let user, !user.isEmpty { parts.append("user=\(user)") }
        if let session, !session.isEmpty { parts.append("session=\(session)") }
        if let q, !q.isEmpty { parts.append("q=\(q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q)") }
        return parts.joined(separator: "&")
    }
}

enum ExportFormat: String {
    case csv
    case json
}
