import SwiftUI

struct ConnectionView: View {
    @Environment(AppState.self) private var appState
    @State private var host: String = ""
    @State private var portText: String = ""

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "network")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)

            Text("连接到 Local Router")
                .font(.title2)
                .fontWeight(.medium)

            Text("输入服务器地址以连接")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            VStack(spacing: 12) {
                HStack(spacing: 8) {
                    TextField("主机", text: $host)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 200)

                    Text(":")
                        .foregroundStyle(.secondary)

                    TextField("端口", text: $portText)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 80)
                }

                Button(action: {
                    appState.connectionSettings.host = host
                    if let port = Int(portText) {
                        appState.connectionSettings.port = port
                    }
                    Task {
                        await appState.connect()
                    }
                }) {
                    if appState.isConnecting {
                        ProgressView()
                            .controlSize(.small)
                            .frame(width: 60)
                    } else {
                        Text("连接")
                            .frame(width: 60)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(appState.isConnecting || host.isEmpty)
                .keyboardShortcut(.return)
            }

            if let error = appState.connectionError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            Spacer()
        }
        .frame(minWidth: 400, minHeight: 300)
        .onAppear {
            host = appState.connectionSettings.host
            portText = String(appState.connectionSettings.port)
        }
    }
}
