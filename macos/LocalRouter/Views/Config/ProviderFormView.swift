import SwiftUI

struct ProviderFormView: View {
    let name: String
    let provider: ProviderConfig
    let onUpdate: (ProviderConfig) -> Void

    @State private var showApiKey = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(name)
                    .font(.title2)
                    .fontWeight(.semibold)

                Form {
                    Section("基本设置") {
                        Picker("协议类型", selection: binding(\.type)) {
                            ForEach(ProviderType.allCases, id: \.self) { type in
                                Text(type.displayName).tag(type)
                            }
                        }

                        TextField("Base URL", text: binding(\.base))

                        HStack {
                            if showApiKey {
                                TextField("API Key", text: binding(\.apiKey))
                            } else {
                                SecureField("API Key", text: binding(\.apiKey))
                            }
                            Button {
                                showApiKey.toggle()
                            } label: {
                                Image(systemName: showApiKey ? "eye.slash" : "eye")
                            }
                            .buttonStyle(.borderless)
                        }

                        TextField("代理 URL (可选)", text: Binding(
                            get: { provider.proxy ?? "" },
                            set: { val in
                                var p = provider
                                p.proxy = val.isEmpty ? nil : val
                                onUpdate(p)
                            }
                        ))
                    }

                    Section("模型") {
                        ModelEditorView(
                            models: provider.models,
                            onUpdate: { models in
                                var p = provider
                                p.models = models
                                onUpdate(p)
                            }
                        )
                    }
                }
                .formStyle(.grouped)
            }
            .padding()
        }
    }

    private func binding<T>(_ keyPath: WritableKeyPath<ProviderConfig, T>) -> Binding<T> {
        Binding(
            get: { provider[keyPath: keyPath] },
            set: { newValue in
                var p = provider
                p[keyPath: keyPath] = newValue
                onUpdate(p)
            }
        )
    }
}
