import SwiftUI

struct ConnectionView: View {
    @Environment(AppState.self) private var appState
    @State private var host: String = ""
    @State private var portText: String = ""
    @FocusState private var hostFocused: Bool

    var body: some View {
        VStack {
            Spacer()

            VStack(spacing: 20) {
                Image(systemName: "network")
                    .font(.system(size: 44))
                    .foregroundStyle(.tint)
                    .symbolEffect(.pulse, isActive: appState.isConnecting)

                VStack(spacing: 4) {
                    Text("连接到 Local Router")
                        .font(.title2)
                        .fontWeight(.semibold)
                    Text("输入服务器地址以连接")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                VStack(spacing: 12) {
                    HStack(spacing: 8) {
                        TextField("主机", text: $host)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 200)
                            .focused($hostFocused)

                        Text(":")
                            .foregroundStyle(.secondary)

                        TextField("端口", text: $portText)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 80)
                    }

                    Button(action: connect) {
                        Group {
                            if appState.isConnecting {
                                ProgressView().controlSize(.small)
                            } else {
                                Text("连接")
                            }
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .primaryActionStyle(enabled: !appState.isConnecting && !host.isEmpty)
                    .controlSize(.large)
                    .disabled(appState.isConnecting || host.isEmpty)
                    .keyboardShortcut(.return)
                }

                if let error = appState.connectionError {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .padding(DS.gapXL + DS.gapS)
            .frame(width: 360)
            .cardSurface(cornerRadius: DS.panelRadius)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .frame(minWidth: 420, minHeight: 340)
        .animation(.smooth, value: appState.connectionError)
        .onAppear {
            host = appState.connectionSettings.host
            portText = String(appState.connectionSettings.port)
            hostFocused = true
        }
    }

    private func connect() {
        appState.connectionSettings.host = host
        if let port = Int(portText) {
            appState.connectionSettings.port = port
        }
        Task {
            await appState.connect()
        }
    }
}
