import SwiftUI

struct JsonTextView: View {
    let json: Any?
    var maxHeight: CGFloat = 400

    var body: some View {
        ScrollView {
            Text(formattedJSON)
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
        }
        .frame(maxHeight: maxHeight)
        .background(.background.secondary)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var formattedJSON: String {
        guard let json else { return "null" }
        if let data = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]),
           let string = String(data: data, encoding: .utf8) {
            return string
        }
        return String(describing: json)
    }
}

struct JsonStringView: View {
    let jsonString: String?
    var maxHeight: CGFloat = 400

    var body: some View {
        ScrollView {
            Text(formattedJSON)
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
        }
        .frame(maxHeight: maxHeight)
        .background(.background.secondary)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var formattedJSON: String {
        guard let jsonString, !jsonString.isEmpty else { return "null" }
        if let data = jsonString.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data),
           let prettyData = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]),
           let pretty = String(data: prettyData, encoding: .utf8) {
            return pretty
        }
        return jsonString
    }
}
