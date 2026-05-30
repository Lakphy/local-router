import SwiftUI

struct ActionBarView: ToolbarContent {
    @Environment(AppState.self) private var appState
    @Environment(ConfigStore.self) private var configStore

    private var busy: Bool {
        configStore.saving || configStore.applying
    }

    var body: some ToolbarContent {
        // Sync status indicator
        ToolbarItem(placement: .automatic) {
            HStack(spacing: 5) {
                Circle()
                    .fill(configStore.isDirty ? Color.orange : Color.green)
                    .frame(width: 6, height: 6)
                Text(configStore.isDirty ? "未保存更改" : "已同步")
                    .font(.caption)
                    .foregroundStyle(configStore.isDirty ? .secondary : .tertiary)
            }
            .padding(.horizontal, 6)
            .contentTransition(.opacity)
            .animation(.snappy, value: configStore.isDirty)
        }

        if #available(macOS 26.0, *) {
            ToolbarSpacer(.fixed)
        }

        // Overflow: Diff / Raw / Reset
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

        // Primary action
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
            .primaryActionStyle(enabled: configStore.isDirty && !busy)
            .disabled(!configStore.isDirty || busy)
        }
    }
}
