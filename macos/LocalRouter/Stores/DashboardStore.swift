import Foundation

@Observable
final class DashboardStore {
    var metrics: LogMetricsResponse?
    var logStorage: LogStorageInfo?
    var metricsWindow: MetricsWindow = .twentyFourHours
    var loading = false
    var error: String?

    func refresh(api: APIClient) async {
        loading = true
        error = nil
        async let m = try? api.fetchLogMetrics(window: metricsWindow)
        async let storage = try? api.fetchLogStorage()

        metrics = await m
        logStorage = await storage
        loading = false
    }

    func fetchMetrics(api: APIClient, window: MetricsWindow? = nil, refresh: Bool = false) async {
        if let window { metricsWindow = window }
        do {
            metrics = try await api.fetchLogMetrics(window: metricsWindow, refresh: refresh)
        } catch {
            self.error = error.localizedDescription
        }
    }

    func fetchLogStorage(api: APIClient, refresh: Bool = false) async {
        do {
            logStorage = try await api.fetchLogStorage(refresh: refresh)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
