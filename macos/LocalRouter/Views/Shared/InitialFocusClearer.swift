import AppKit
import SwiftUI

/// Clears the window's auto-assigned first responder once, shortly after this
/// view is created. On macOS, AppKit makes the first `NSTextField` (here, the
/// route model-alias field) the initial first responder when a window/page
/// appears — which is unwanted on the dashboard homepage.
///
/// This runs only at creation time, so it never steals focus while the user is
/// actually editing a field later on.
struct InitialFocusClearer: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        scheduleClear(for: view, attempt: 0)
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}

    private func scheduleClear(for view: NSView, attempt: Int) {
        // ~20 attempts spaced 16ms apart (~320ms total) — long enough to catch
        // focus assigned a frame or two after appear, short enough to finish
        // before any user interaction at page load.
        guard attempt < 20 else { return }
        let delay = attempt == 0 ? DispatchTime.now() : DispatchTime.now() + 0.016
        DispatchQueue.main.asyncAfter(deadline: delay) {
            guard let window = view.window else {
                scheduleClear(for: view, attempt: attempt + 1)
                return
            }
            let responder = window.firstResponder
            if responder is NSTextView || responder is NSText {
                // A text field grabbed the initial focus — release it.
                window.makeFirstResponder(nil)
            } else {
                scheduleClear(for: view, attempt: attempt + 1)
            }
        }
    }
}
