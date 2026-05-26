import SwiftUI

struct ActionBarView: ToolbarContent {
    @Environment(AppState.self) private var appState
    @Environment(ConfigStore.self) private var configStore

    private var busy: Bool {
        configStore.saving || configStore.applying
    }

    var body: some ToolbarContent {
        // Status indicator
        ToolbarItem(placement: .automatic) {
            if configStore.isDirty {
                HStack(spacing: 5) {
                    Circle().fill(.orange).frame(width: 6, height: 6)
                    Text("未保存更改")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 6)
            } else {
                HStack(spacing: 5) {
                    Circle().fill(.green.opacity(0.6)).frame(width: 6, height: 6)
                    Text("已同步")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 6)
            }
        }

        // More menu: Diff / Raw / Reset
        ToolbarItem(placement: .automatic) {
            Menu {
                Button {
                    configStore.diffMode = .view
                    configStore.showDiffSheet = true
                } label: {
                    Label("查看 Diff", systemImage: "arrow.left.arrow.right")
                }
                .disabled(busy)

                Button {
                    configStore.showRawEditor = true
                } label: {
                    Label("查看 Raw", systemImage: "doc.text")
                }
                .disabled(busy)

                Divider()

                Button(role: .destructive) {
                    configStore.reset()
                } label: {
                    Label("重置更改", systemImage: "arrow.counterclockwise")
                }
                .disabled(!configStore.isDirty || busy)
            } label: {
                Image(systemName: "ellipsis.circle")
            }
        }

        // Apply
        ToolbarItem(placement: .automatic) {
            Button {
                configStore.diffMode = .saveAndApply
                configStore.showDiffSheet = true
            } label: {
                if busy {
                    ProgressView().controlSize(.small)
                } else {
                    Text("应用更改")
                }
            }
            .disabled(!configStore.isDirty || busy)
        }
    }
}
