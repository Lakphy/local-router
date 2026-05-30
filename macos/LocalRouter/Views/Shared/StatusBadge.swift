import SwiftUI

struct StatusBadge: View {
    let text: String
    let color: Color

    init(_ text: String, color: Color = .secondary) {
        self.text = text
        self.color = color
    }

    var body: some View {
        Text(text)
            .font(.caption2)
            .fontWeight(.medium)
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.15), in: .capsule)
    }

    static func forStatusClass(_ statusClass: StatusClass) -> StatusBadge {
        switch statusClass {
        case .twoXX: StatusBadge("2xx", color: .green)
        case .fourXX: StatusBadge("4xx", color: .orange)
        case .fiveXX: StatusBadge("5xx", color: .red)
        case .networkError: StatusBadge("NET", color: .red)
        }
    }

    static func forLevel(_ level: LogLevel) -> StatusBadge {
        switch level {
        case .info: StatusBadge("INFO", color: .blue)
        case .error: StatusBadge("ERROR", color: .red)
        }
    }
}
