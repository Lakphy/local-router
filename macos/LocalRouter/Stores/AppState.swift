import Foundation

enum NavigationPage: String, CaseIterable, Hashable {
    case dashboard
    case logs
    case sessions
    case generalSettings
    case providers
    case routes
    case logsSettings

    var title: String {
        switch self {
        case .dashboard: "仪表盘"
        case .logs: "日志检索"
        case .sessions: "用户会话"
        case .generalSettings: "通用设置"
        case .providers: "服务商配置"
        case .routes: "路由配置"
        case .logsSettings: "日志设置"
        }
    }

    var subtitle: String {
        switch self {
        case .dashboard: "Local Router 服务状态与配置概览"
        case .logs: "查询和分析请求日志"
        case .sessions: "按用户和会话聚合日志"
        case .generalSettings: "服务器与启动选项"
        case .providers: "管理上游服务商与模型"
        case .routes: "管理协议入口与模型路由映射"
        case .logsSettings: "日志记录与存储策略"
        }
    }

    var icon: String {
        switch self {
        case .dashboard: "gauge"
        case .logs: "doc.text.magnifyingglass"
        case .sessions: "person.2"
        case .generalSettings: "gearshape"
        case .providers: "server.rack"
        case .routes: "arrow.triangle.branch"
        case .logsSettings: "doc.badge.gearshape"
        }
    }

    var isConfigPage: Bool {
        switch self {
        case .generalSettings, .providers, .routes, .logsSettings: true
        default: false
        }
    }

    static var observePages: [NavigationPage] {
        [.dashboard, .logs, .sessions]
    }

    static var configPages: [NavigationPage] {
        [.generalSettings, .providers, .routes, .logsSettings]
    }
}

@Observable
final class AppState {
    var isConnected = false
    var isConnecting = false
    var connectionError: String?
    var selectedPage: NavigationPage = .dashboard

    let connectionSettings = ConnectionSettings()
    let apiClient = APIClient()
    let configStore = ConfigStore()
    let dashboardStore = DashboardStore()
    let logsStore = LogsStore()
    let sessionsStore = SessionsStore()

    func connect() async {
        isConnecting = true
        connectionError = nil
        apiClient.baseURL = connectionSettings.baseURL

        let healthy = await apiClient.checkHealth()
        if healthy {
            isConnected = true
            connectionError = nil
            await configStore.loadConfig(api: apiClient)
        } else {
            connectionError = "无法连接到 \(connectionSettings.displayAddress)"
        }
        isConnecting = false
    }

    func disconnect() {
        isConnected = false
        logsStore.stopRealtime()
        configStore.reset()
    }

    func autoConnect() async {
        apiClient.baseURL = connectionSettings.baseURL
        let healthy = await apiClient.checkHealth()
        if healthy {
            isConnected = true
            await configStore.loadConfig(api: apiClient)
        }
    }
}
