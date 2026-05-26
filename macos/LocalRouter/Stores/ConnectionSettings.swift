import Foundation
import SwiftUI

@Observable
final class ConnectionSettings {
    @ObservationIgnored
    @AppStorage("serverHost") var host = "localhost"

    @ObservationIgnored
    @AppStorage("serverPort") var port = 4099

    var baseURL: URL {
        URL(string: "http://\(host):\(port)")!
    }

    var wsURL: URL {
        URL(string: "ws://\(host):\(port)/api/logs/events/ws")!
    }

    var displayAddress: String {
        "\(host):\(port)"
    }
}
