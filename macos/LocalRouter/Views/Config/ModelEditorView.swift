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
                ModelRow(
                    name: name,
                    capabilities: models[name] ?? ModelCapabilities(),
                    onRename: { newName in rename(from: name, to: newName) },
                    onUpdateCapabilities: { caps in
                        var m = models
                        m[name] = caps
                        onUpdate(m)
                    },
                    onDelete: {
                        var m = models
                        m.removeValue(forKey: name)
                        onUpdate(m)
                    }
                )
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

    private func rename(from old: String, to new: String) {
        let trimmed = new.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed != old, models[trimmed] == nil else { return }
        var m = models
        let caps = m.removeValue(forKey: old) ?? ModelCapabilities()
        m[trimmed] = caps
        onUpdate(m)
    }
}

// MARK: - Model Row

private struct ModelRow: View {
    let name: String
    let capabilities: ModelCapabilities
    let onRename: (String) -> Void
    let onUpdateCapabilities: (ModelCapabilities) -> Void
    let onDelete: () -> Void

    @State private var draftName: String
    @FocusState private var nameFocused: Bool

    init(
        name: String,
        capabilities: ModelCapabilities,
        onRename: @escaping (String) -> Void,
        onUpdateCapabilities: @escaping (ModelCapabilities) -> Void,
        onDelete: @escaping () -> Void
    ) {
        self.name = name
        self.capabilities = capabilities
        self.onRename = onRename
        self.onUpdateCapabilities = onUpdateCapabilities
        self.onDelete = onDelete
        _draftName = State(initialValue: name)
    }

    var body: some View {
        HStack {
            TextField("模型 ID", text: $draftName)
                .textFieldStyle(.roundedBorder)
                .font(.system(.body, design: .monospaced))
                .focused($nameFocused)
                .onSubmit(commitRename)
                .onChange(of: nameFocused) { _, focused in
                    if !focused { commitRename() }
                }

            Spacer()

            Toggle("图像", isOn: Binding(
                get: { capabilities.imageInput ?? false },
                set: { val in
                    onUpdateCapabilities(ModelCapabilities(
                        imageInput: val ? true : nil,
                        reasoning: capabilities.reasoning
                    ))
                }
            ))
            .toggleStyle(.checkbox)
            .font(.caption)

            Toggle("推理", isOn: Binding(
                get: { capabilities.reasoning ?? false },
                set: { val in
                    onUpdateCapabilities(ModelCapabilities(
                        imageInput: capabilities.imageInput,
                        reasoning: val ? true : nil
                    ))
                }
            ))
            .toggleStyle(.checkbox)
            .font(.caption)

            Button(action: onDelete) {
                Image(systemName: "trash")
                    .font(.caption)
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.red)
        }
        .onChange(of: name) { _, newName in
            draftName = newName
        }
    }

    private func commitRename() {
        let trimmed = draftName.trimmingCharacters(in: .whitespaces)
        if trimmed == name { return }
        if trimmed.isEmpty {
            draftName = name
            return
        }
        onRename(trimmed)
    }
}
