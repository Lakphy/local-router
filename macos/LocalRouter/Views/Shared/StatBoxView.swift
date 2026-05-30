import SwiftUI

struct StatBoxView: View {
    let title: String
    let value: String
    let subtitle: String?
    var valueColor: Color = .primary

    init(_ title: String, value: String, subtitle: String? = nil, valueColor: Color = .primary) {
        self.title = title
        self.value = value
        self.subtitle = subtitle
        self.valueColor = valueColor
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title3)
                .fontWeight(.semibold)
                .foregroundStyle(valueColor)
            if let subtitle {
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .cardSurface()
    }
}
