import Foundation

enum Formatters {
    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoFormatterNoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    private static let dateTimeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MM-dd HH:mm:ss"
        return f
    }()

    static func parseISO(_ string: String) -> Date? {
        isoFormatter.date(from: string) ?? isoFormatterNoFrac.date(from: string)
    }

    static func formatTime(_ isoString: String) -> String {
        guard let date = parseISO(isoString) else { return isoString }
        return timeFormatter.string(from: date)
    }

    static func formatDateTime(_ isoString: String) -> String {
        guard let date = parseISO(isoString) else { return isoString }
        return dateTimeFormatter.string(from: date)
    }

    static func formatBytes(_ bytes: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .binary
        return formatter.string(fromByteCount: Int64(bytes))
    }

    static func formatLatency(_ ms: Double) -> String {
        if ms < 1000 {
            return String(format: "%.0fms", ms)
        } else {
            return String(format: "%.1fs", ms / 1000)
        }
    }

    static func formatNumber(_ n: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter.string(from: NSNumber(value: n)) ?? "\(n)"
    }

    static func formatPercent(_ value: Double) -> String {
        let s = String(format: "%.2f", value)
        let trimmed = s.replacingOccurrences(of: "0+$", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\.$", with: "", options: .regularExpression)
        return "\(trimmed)%"
    }

    static func formatCompact(_ n: Int?) -> String {
        let value = n ?? 0
        if abs(value) >= 100_000 {
            let formatter = NumberFormatter()
            formatter.numberStyle = .decimal
            formatter.maximumFractionDigits = 1
            if abs(value) >= 1_000_000_000 {
                let v = Double(value) / 1_000_000_000
                return (formatter.string(from: NSNumber(value: v)) ?? "\(v)") + "B"
            } else if abs(value) >= 1_000_000 {
                let v = Double(value) / 1_000_000
                return (formatter.string(from: NSNumber(value: v)) ?? "\(v)") + "M"
            } else {
                let v = Double(value) / 1_000
                return (formatter.string(from: NSNumber(value: v)) ?? "\(v)") + "K"
            }
        }
        return formatNumber(value)
    }
}
