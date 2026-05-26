import Foundation

// MARK: - Client -> Server

enum WSClientMessage: Encodable {
    case subscribe(requestId: String, query: [String: Any]?)
    case unsubscribe(subscriptionId: String?)
    case ping(ts: String)

    func encode(to encoder: Encoder) throws {
        // Use JSONSerialization for flexibility with Any types
    }

    func toJSONData() throws -> Data {
        var dict: [String: Any] = [:]
        switch self {
        case .subscribe(let requestId, let query):
            dict["type"] = "subscribe"
            dict["requestId"] = requestId
            if let query { dict["query"] = query }
        case .unsubscribe(let subscriptionId):
            dict["type"] = "unsubscribe"
            if let subscriptionId { dict["subscriptionId"] = subscriptionId }
        case .ping(let ts):
            dict["type"] = "ping"
            dict["ts"] = ts
        }
        return try JSONSerialization.data(withJSONObject: dict)
    }
}

// MARK: - Server -> Client

enum WSServerMessage: Sendable {
    case ready(connectionId: String, now: String)
    case subscribed(requestId: String?, subscriptionId: String, queryHash: String, now: String)
    case unsubscribed(subscriptionId: String, reason: String?)
    case logEvent(subscriptionId: String, item: LogEventSummary)
    case overflow(subscriptionId: String, dropped: Int, message: String)
    case pong(ts: String)
    case error(requestId: String?, error: String)
    case unknown(type: String)

    static func parse(from data: Data) -> WSServerMessage? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            return nil
        }

        switch type {
        case "ready":
            guard let connectionId = json["connectionId"] as? String,
                  let now = json["now"] as? String else { return nil }
            return .ready(connectionId: connectionId, now: now)

        case "subscribed":
            guard let subscriptionId = json["subscriptionId"] as? String,
                  let queryHash = json["queryHash"] as? String,
                  let now = json["now"] as? String else { return nil }
            return .subscribed(
                requestId: json["requestId"] as? String,
                subscriptionId: subscriptionId,
                queryHash: queryHash,
                now: now
            )

        case "unsubscribed":
            guard let subscriptionId = json["subscriptionId"] as? String else { return nil }
            return .unsubscribed(subscriptionId: subscriptionId, reason: json["reason"] as? String)

        case "log.event":
            guard let subscriptionId = json["subscriptionId"] as? String,
                  let itemData = try? JSONSerialization.data(withJSONObject: json["item"] as Any),
                  let item = try? JSONDecoder().decode(LogEventSummary.self, from: itemData) else {
                return nil
            }
            return .logEvent(subscriptionId: subscriptionId, item: item)

        case "overflow":
            guard let subscriptionId = json["subscriptionId"] as? String,
                  let dropped = json["dropped"] as? Int,
                  let message = json["message"] as? String else { return nil }
            return .overflow(subscriptionId: subscriptionId, dropped: dropped, message: message)

        case "pong":
            guard let ts = json["ts"] as? String else { return nil }
            return .pong(ts: ts)

        case "error":
            guard let error = json["error"] as? String else { return nil }
            return .error(requestId: json["requestId"] as? String, error: error)

        default:
            return .unknown(type: type)
        }
    }
}
