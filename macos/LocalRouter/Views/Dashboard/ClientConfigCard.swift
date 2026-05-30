import SwiftUI

struct ClientConfigCard: View {
    @Environment(AppState.self) private var appState
    @Environment(ConfigStore.self) private var configStore

    private var port: Int {
        configStore.config?.server?.port ?? appState.connectionSettings.port
    }

    private var lanEnabled: Bool {
        configStore.config?.server?.lanAccess?.enabled == true
    }

    private var base: String { "http://localhost:\(port)" }

    private var endpoints: [(label: String, url: String)] {
        [
            ("Anthropic Messages", "\(base)/anthropic-messages"),
            ("OpenAI Responses", "\(base)/openai-responses/v1"),
            ("OpenAI Completions", "\(base)/openai-completions/v1"),
        ]
    }

    private var claudeText: String {
        """
        # Claude Code 环境变量
        export ANTHROPIC_BASE_URL="\(base)/anthropic-messages"
        export ANTHROPIC_AUTH_TOKEN="local-router"  # 占位即可，转发时由 provider.apiKey 替换
        # 模型名走路由映射；如需指定可设置:
        # export ANTHROPIC_MODEL="<路由中配置的模型别名>"
        """
    }

    private var codexText: String {
        """
        # ~/.codex/config.toml
        model = "<路由中配置的模型别名>"
        model_provider = "local-router"

        [model_providers.local-router]
        name = "Local Router"
        base_url = "\(base)/openai-responses/v1"
        wire_api = "responses"
        env_key = "LOCAL_ROUTER_KEY"   # 任意非空值: export LOCAL_ROUTER_KEY=local-router
        """
    }

    private var opencodeText: String {
        """
        {
          "$schema": "https://opencode.ai/config.json",
          "provider": {
            "local-router-responses": {
              "npm": "@ai-sdk/openai",
              "name": "Local Router (Responses)",
              "options": {
                "baseURL": "\(base)/openai-responses/v1",
                "apiKey": "local-router"
              },
              "models": { "<模型别名>": { "name": "<模型别名>" } }
            },
            "local-router-completions": {
              "npm": "@ai-sdk/openai-compatible",
              "name": "Local Router (Completions)",
              "options": {
                "baseURL": "\(base)/openai-completions/v1",
                "apiKey": "local-router"
              },
              "models": { "<模型别名>": { "name": "<模型别名>" } }
            }
          }
        }
        """
    }

    private var lanText: String {
        """
        # 局域网访问指引
        # 1. 在「通用设置」开启「局域网访问 (lanAccess)」，保存并应用
        # 2. 查询本机局域网 IP:
        #    macOS:   ipconfig getifaddr en0
        #    Linux:   hostname -I
        #    Windows: ipconfig  (查看 IPv4 地址)
        # 3. 把上面配置里的 localhost 换成该 IP，端口保持 \(port)
        #    例如: http://192.168.x.x:\(port)/anthropic-messages
        # 4. 确保系统防火墙放行 \(port) 端口；同一局域网内的设备即可访问
        """
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DS.gapM) {
            VStack(alignment: .leading, spacing: 2) {
                Text("客户端配置方式")
                    .font(.system(.headline, weight: .semibold))
                Text("把 Claude Code / Codex / OpenCode 指向本地 local-router（当前端口 \(port)）")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // Endpoints
            HStack(spacing: 6) {
                Text("服务入口")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                StatusBadge(lanEnabled ? "局域网已开启" : "局域网未开启", color: lanEnabled ? .green : .secondary)
            }

            VStack(spacing: 6) {
                ForEach(endpoints, id: \.url) { endpoint in
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(endpoint.label)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text(endpoint.url)
                                .font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Spacer()
                        CopyButton(text: endpoint.url)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .cardSurface(cornerRadius: DS.controlRadius)
                }
            }

            Divider()

            ConfigCodeBlock(title: "Claude Code", hint: "环境变量", content: claudeText)
            ConfigCodeBlock(title: "Codex", hint: "~/.codex/config.toml", content: codexText)
            ConfigCodeBlock(title: "OpenCode", hint: "opencode.json", content: opencodeText)
            ConfigCodeBlock(title: "局域网使用", hint: "供同一网络内的其他设备访问", content: lanText)
        }
        .padding(DS.gapM)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
    }
}

private struct ConfigCodeBlock: View {
    let title: String
    let hint: String
    let content: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.caption)
                        .fontWeight(.medium)
                    Text(hint)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                CopyButton(text: content)
            }
            ScrollView(.horizontal) {
                Text(content)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.background.secondary, in: .rect(cornerRadius: DS.controlRadius))
        }
        .padding(8)
        .cardSurface(cornerRadius: DS.controlRadius)
    }
}
