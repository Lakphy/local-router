import SwiftUI

struct ModelEditorView: View {
    let models: [String: ModelCapabilities]
    let onUpdate: ([String: ModelCapabilities]) -> Void
    @State private var newModelName = ""

    private var sortedKeys: [String] {
        Array(models.keys).sorted()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(sortedKeys, id: \.self) { name in
                HStack {
                    Text(name)
                        .font(.system(.body, design: .monospaced))

                    Spacer()

                    Toggle("图像", isOn: Binding(
                        get: { models[name]?.imageInput ?? false },
                        set: { val in
                            var m = models
                            m[name] = ModelCapabilities(
                                imageInput: val ? true : nil,
                                reasoning: models[name]?.reasoning
                            )
                            onUpdate(m)
                        }
                    ))
                    .toggleStyle(.checkbox)
                    .font(.caption)

                    Toggle("推理", isOn: Binding(
                        get: { models[name]?.reasoning ?? false },
                        set: { val in
                            var m = models
                            m[name] = ModelCapabilities(
                                imageInput: models[name]?.imageInput,
                                reasoning: val ? true : nil
                            )
                            onUpdate(m)
                        }
                    ))
                    .toggleStyle(.checkbox)
                    .font(.caption)

                    Button {
                        var m = models
                        m.removeValue(forKey: name)
                        onUpdate(m)
                    } label: {
                        Image(systemName: "trash")
                            .font(.caption)
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.red)
                }
            }

            HStack {
                TextField("新模型名称", text: $newModelName)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 200)

                Button("添加") {
                    guard !newModelName.trimmingCharacters(in: .whitespaces).isEmpty else { return }
                    var m = models
                    m[newModelName] = ModelCapabilities()
                    onUpdate(m)
                    newModelName = ""
                }
                .buttonStyle(.bordered)
                .disabled(newModelName.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }
}
