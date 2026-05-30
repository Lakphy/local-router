import Foundation

@Observable
final class SessionsStore {
    var window: LogQueryWindow = .twentyFourHours
    var user: String = ""
    var session: String = ""
    var keyword: String = ""
    var response: LogSessionsResponse?
    var loading = false
    var error: String?

    func fetchData(api: APIClient) async {
        loading = true
        error = nil
        do {
            var params = SessionQueryParams()
            params.window = window
            if !user.isEmpty { params.user = user }
            if !session.isEmpty { params.session = session }
            if !keyword.isEmpty { params.q = keyword }
            response = try await api.fetchLogSessions(params: params)
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    func resetFilters() {
        window = .twentyFourHours
        user = ""
        session = ""
        keyword = ""
    }
}
