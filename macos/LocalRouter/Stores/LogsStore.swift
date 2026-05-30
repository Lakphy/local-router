import Foundation

@Observable
final class LogsStore {
    // Filters
    var window: LogQueryWindow = .twentyFourHours
    var fromDate: String?
    var toDate: String?
    var levels: [LogLevel] = []
    var provider: String = ""
    var routeType: String = ""
    var model: String = ""
    var modelIn: String = ""
    var modelOut: String = ""
    var user: String = ""
    var session: String = ""
    var statusClasses: [StatusClass] = []
    var hasError: Bool?
    var keyword: String = ""
    var sort: LogQueryParams.SortOrder = .timeDesc

    // Results
    var items: [LogEventSummary] = []
    var stats: LogQueryStats?
    var meta: LogQueryMeta?
    var nextCursor: String?
    var hasMore = false
    var loading = false
    var loadingMore = false
    var error: String?

    // Realtime
    var realtimeEnabled = false
    private var wsClient: WebSocketClient?
    private var realtimeTask: Task<Void, Never>?
    private var batchBuffer: [LogEventSummary] = []
    private var flushTask: Task<Void, Never>?

    var canEnableRealtime: Bool {
        sort == .timeDesc && toDate == nil
    }

    // Time range pinned at the start of a query so that cursor-based pagination
    // stays valid. `window=24h` resolves to `[now-24h, now]` server-side on every
    // request, and the resolved range is baked into the cursor's hash — so without
    // pinning, "load more" a few seconds later is rejected as a cursor mismatch.
    private var pinnedFrom: String?
    private var pinnedTo: String?

    private static let isoFormatter = ISO8601DateFormatter()

    private func pinRangeForNewQuery() {
        guard fromDate == nil && toDate == nil else {
            pinnedFrom = nil
            pinnedTo = nil
            return
        }
        let now = Date()
        pinnedTo = Self.isoFormatter.string(from: now)
        pinnedFrom = Self.isoFormatter.string(from: now.addingTimeInterval(-window.seconds))
    }

    private var currentParams: LogQueryParams {
        var params = LogQueryParams()
        if let pinnedFrom, let pinnedTo {
            params.from = pinnedFrom
            params.to = pinnedTo
        } else {
            params.window = window
            params.from = fromDate
            params.to = toDate
        }
        params.levels = levels.isEmpty ? nil : levels
        params.provider = provider
        params.routeType = routeType
        params.model = model
        params.modelIn = modelIn
        params.modelOut = modelOut
        params.user = user
        params.session = session
        params.statusClass = statusClasses.isEmpty ? nil : statusClasses
        params.hasError = hasError
        params.q = keyword.isEmpty ? nil : keyword
        params.sort = sort
        params.limit = 50
        return params
    }

    func fetchFirstPage(api: APIClient) async {
        loading = true
        error = nil
        nextCursor = nil
        pinRangeForNewQuery()
        do {
            let response = try await api.fetchLogEvents(params: currentParams)
            items = response.items
            stats = response.stats
            meta = response.meta
            nextCursor = response.nextCursor
            hasMore = response.hasMore
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    func fetchNextPage(api: APIClient) async {
        guard hasMore, let cursor = nextCursor, !loadingMore else { return }
        loadingMore = true
        var params = currentParams
        params.cursor = cursor
        do {
            let response = try await api.fetchLogEvents(params: params)
            items.append(contentsOf: response.items)
            nextCursor = response.nextCursor
            hasMore = response.hasMore
        } catch {
            self.error = error.localizedDescription
        }
        loadingMore = false
    }

    func resetFilters() {
        window = .twentyFourHours
        fromDate = nil
        toDate = nil
        levels = []
        provider = ""
        routeType = ""
        model = ""
        modelIn = ""
        modelOut = ""
        user = ""
        session = ""
        statusClasses = []
        hasError = nil
        keyword = ""
        sort = .timeDesc
    }

    // MARK: - Realtime

    func startRealtime(wsURL: URL) {
        guard canEnableRealtime else { return }
        stopRealtime()
        realtimeEnabled = true

        let client = WebSocketClient()
        wsClient = client
        let stream = client.connect(url: wsURL)

        realtimeTask = Task { [weak self] in
            guard let self else { return }

            // Wait for ready, then subscribe
            for await message in stream {
                if case .ready = message {
                    let query = self.buildRealtimeQuery()
                    try? await client.subscribe(query: query)
                    break
                }
            }

            for await message in stream {
                if Task.isCancelled { break }
                if case .logEvent(_, let item) = message {
                    self.bufferEvent(item)
                }
            }
        }
    }

    func stopRealtime() {
        realtimeEnabled = false
        realtimeTask?.cancel()
        realtimeTask = nil
        flushTask?.cancel()
        flushTask = nil
        wsClient?.disconnect()
        wsClient = nil
        batchBuffer = []
    }

    private func bufferEvent(_ event: LogEventSummary) {
        batchBuffer.append(event)

        if flushTask == nil {
            flushTask = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(50))
                guard let self else { return }
                let batch = self.batchBuffer
                self.batchBuffer = []
                self.flushTask = nil
                self.items.insert(contentsOf: batch, at: 0)
            }
        }
    }

    private func buildRealtimeQuery() -> [String: Any] {
        var query: [String: Any] = [:]
        query["window"] = window.rawValue
        if !levels.isEmpty { query["levels"] = levels.map(\.rawValue) }
        if !provider.isEmpty { query["provider"] = provider }
        if !routeType.isEmpty { query["routeType"] = routeType }
        if !model.isEmpty { query["model"] = model }
        if !user.isEmpty { query["user"] = user }
        if !session.isEmpty { query["session"] = session }
        if !statusClasses.isEmpty { query["statusClass"] = statusClasses.map(\.rawValue) }
        if let hasError { query["hasError"] = hasError }
        if !keyword.isEmpty { query["q"] = keyword }
        return query
    }
}
