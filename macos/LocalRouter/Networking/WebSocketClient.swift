import Foundation

@Observable
final class WebSocketClient {
    enum Status: Equatable {
        case disconnected
        case connecting
        case connected
        case error(String)
    }

    private(set) var status: Status = .disconnected
    private(set) var subscriptionId: String?
    private var task: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var continuation: AsyncStream<WSServerMessage>.Continuation?
    private let session = URLSession(configuration: .default)

    var isConnected: Bool { status == .connected }

    func connect(url: URL) -> AsyncStream<WSServerMessage> {
        disconnect()
        status = .connecting

        let stream = AsyncStream<WSServerMessage> { continuation in
            self.continuation = continuation
        }

        let wsTask = session.webSocketTask(with: url)
        self.task = wsTask
        wsTask.resume()

        receiveTask = Task { [weak self] in
            await self?.receiveLoop()
        }

        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled else { break }
                await self?.sendPing()
            }
        }

        return stream
    }

    func subscribe(query: [String: Any]? = nil) async throws {
        let requestId = UUID().uuidString
        let message = try WSClientMessage.subscribe(requestId: requestId, query: query).toJSONData()
        guard let string = String(data: message, encoding: .utf8) else { return }
        try await task?.send(.string(string))
    }

    func unsubscribe() async throws {
        let message = try WSClientMessage.unsubscribe(subscriptionId: subscriptionId).toJSONData()
        guard let string = String(data: message, encoding: .utf8) else { return }
        try await task?.send(.string(string))
        subscriptionId = nil
    }

    func disconnect() {
        receiveTask?.cancel()
        receiveTask = nil
        pingTask?.cancel()
        pingTask = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        continuation?.finish()
        continuation = nil
        subscriptionId = nil
        if status != .disconnected {
            status = .disconnected
        }
    }

    private func receiveLoop() async {
        guard let task else { return }

        while !Task.isCancelled {
            do {
                let message = try await task.receive()
                switch message {
                case .string(let text):
                    if let data = text.data(using: .utf8),
                       let parsed = WSServerMessage.parse(from: data) {
                        handleMessage(parsed)
                        continuation?.yield(parsed)
                    }
                case .data(let data):
                    if let parsed = WSServerMessage.parse(from: data) {
                        handleMessage(parsed)
                        continuation?.yield(parsed)
                    }
                @unknown default:
                    break
                }
            } catch {
                if !Task.isCancelled {
                    status = .error(error.localizedDescription)
                    continuation?.finish()
                }
                break
            }
        }
    }

    private func handleMessage(_ message: WSServerMessage) {
        switch message {
        case .ready:
            status = .connected
        case .subscribed(_, let subId, _, _):
            subscriptionId = subId
        case .unsubscribed:
            subscriptionId = nil
        case .error(_, let error):
            status = .error(error)
        default:
            break
        }
    }

    private func sendPing() async {
        let ts = ISO8601DateFormatter().string(from: Date())
        guard let data = try? WSClientMessage.ping(ts: ts).toJSONData(),
              let string = String(data: data, encoding: .utf8) else { return }
        try? await task?.send(.string(string))
    }

    deinit {
        disconnect()
    }
}
