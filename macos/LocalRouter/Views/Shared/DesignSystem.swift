import SwiftUI

enum DS {
    // Corner radii
    static let panelRadius: CGFloat = 16
    static let cardRadius: CGFloat = 10
    static let controlRadius: CGFloat = 8

    // Spacing scale
    static let gapXS: CGFloat = 4
    static let gapS: CGFloat = 8
    static let gapM: CGFloat = 12
    static let gapL: CGFloat = 16
    static let gapXL: CGFloat = 24
    static let padPage: CGFloat = 16
}

extension View {
    /// Content surface — a material-like card. Reserved for *content*, never glass
    /// (Liquid Glass belongs on the control/navigation layer).
    func cardSurface(cornerRadius: CGFloat = DS.cardRadius) -> some View {
        self
            .background(.background.secondary, in: .rect(cornerRadius: cornerRadius))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius)
                    .strokeBorder(.separator.opacity(0.6), lineWidth: 0.5)
            )
    }

    /// Route rule row surface. `wildcard` uses a dashed border to read as a fallback.
    func ruleRowSurface(wildcard: Bool = false) -> some View {
        self
            .background(
                (wildcard ? AnyShapeStyle(.quaternary.opacity(0.4)) : AnyShapeStyle(.background.secondary)),
                in: .rect(cornerRadius: DS.controlRadius)
            )
            .overlay(
                RoundedRectangle(cornerRadius: DS.controlRadius)
                    .strokeBorder(.separator,
                                  style: StrokeStyle(lineWidth: 1, dash: wildcard ? [4, 3] : []))
            )
    }

    /// Primary call-to-action button style.
    @ViewBuilder
    func primaryActionStyle() -> some View {
        if #available(macOS 26.0, *) {
            self.buttonStyle(.glassProminent)
        } else {
            self.buttonStyle(.borderedProminent)
        }
    }

    /// Primary call-to-action, but only prominent while actionable. When disabled,
    /// falls back to the secondary (non-prominent) style so it doesn't sit in the
    /// toolbar as a bright, fully-tinted glass button. Pair with `.disabled(!enabled)`.
    @ViewBuilder
    func primaryActionStyle(enabled: Bool) -> some View {
        if enabled {
            self.primaryActionStyle()
        } else {
            self.secondaryActionStyle()
        }
    }

    /// Secondary button style.
    @ViewBuilder
    func secondaryActionStyle() -> some View {
        if #available(macOS 26.0, *) {
            self.buttonStyle(.glass)
        } else {
            self.buttonStyle(.bordered)
        }
    }

    /// Soft scroll-edge fade where content scrolls beneath toolbar/navigation chrome.
    /// macOS 26 only; no-op below. Use on every primary scrolling surface.
    @ViewBuilder
    func contentScroll() -> some View {
        if #available(macOS 26.0, *) {
            self.scrollEdgeEffectStyle(.soft, for: .all)
        } else {
            self
        }
    }
}
