import SwiftUI

struct RouteConfigCard: View {
    @Environment(ConfigStore.self) private var configStore

    private var busy: Bool {
        configStore.saving || configStore.applying
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DS.gapM) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("路由配置")
                        .font(.system(.headline, weight: .semibold))
                    Text("直接在仪表盘编辑模型路由，应用后即刻生效")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                HStack(spacing: 6) {
                    Circle()
                        .fill(configStore.isDirty ? Color.orange : Color.green)
                        .frame(width: 6, height: 6)
                    Text(configStore.isDirty ? "未保存更改" : "已同步")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Button {
                    configStore.reset()
                } label: {
                    Image(systemName: "arrow.counterclockwise")
                }
                .buttonStyle(.borderless)
                .help("重置更改")
                .disabled(!configStore.isDirty || busy)

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

            RoutesEditorView(disableInitialFocus: true)
        }
        .padding(DS.gapM)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
    }
}
