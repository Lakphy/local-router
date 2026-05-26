import SwiftUI

struct LogsSettingsPage: View {
    @Environment(ConfigStore.self) private var configStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("日志设置")
                    .font(.title2)
                    .fontWeight(.semibold)

                if configStore.draft != nil {
                    Form {
                        Section("日志记录") {
                            Toggle("启用日志", isOn: logBinding(\.enabled, default: true))

                            Picker("Body 策略", selection: Binding(
                                get: { configStore.draft?.log?.bodyPolicy ?? .full },
                                set: { val in
                                    configStore.updateDraft {
                                        $0.log = $0.log ?? LogConfig()
                                        $0.log?.bodyPolicy = val
                                    }
                                }
                            )) {
                                ForEach(BodyPolicy.allCases, id: \.self) { policy in
                                    Text(policy.rawValue).tag(policy)
                                }
                            }
                        }

                        Section("事件存储") {
                            TextField("保留天数", value: Binding(
                                get: { configStore.draft?.log?.events?.retainDays ?? 7 },
                                set: { val in
                                    configStore.updateDraft {
                                        $0.log = $0.log ?? LogConfig()
                                        $0.log?.events = LogEventsConfig(retainDays: val)
                                    }
                                }
                            ), format: .number)
                        }

                        Section("流式日志") {
                            Toggle("启用流捕获", isOn: Binding(
                                get: { configStore.draft?.log?.streams?.enabled ?? true },
                                set: { val in
                                    configStore.updateDraft {
                                        var log = $0.log ?? LogConfig()
                                        var streams = log.streams ?? LogStreamsConfig()
                                        streams.enabled = val
                                        log.streams = streams
                                        $0.log = log
                                    }
                                }
                            ))

                            TextField("保留天数", value: Binding(
                                get: { configStore.draft?.log?.streams?.retainDays ?? 3 },
                                set: { val in
                                    configStore.updateDraft {
                                        var log = $0.log ?? LogConfig()
                                        var streams = log.streams ?? LogStreamsConfig()
                                        streams.retainDays = val
                                        log.streams = streams
                                        $0.log = log
                                    }
                                }
                            ), format: .number)

                            TextField("最大字节/请求", value: Binding(
                                get: { configStore.draft?.log?.streams?.maxBytesPerRequest ?? 1048576 },
                                set: { val in
                                    configStore.updateDraft {
                                        var log = $0.log ?? LogConfig()
                                        var streams = log.streams ?? LogStreamsConfig()
                                        streams.maxBytesPerRequest = val
                                        log.streams = streams
                                        $0.log = log
                                    }
                                }
                            ), format: .number)
                        }
                    }
                    .formStyle(.grouped)
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .padding()
        }
    }

    private func logBinding(_ keyPath: WritableKeyPath<LogConfig, Bool?>, default defaultValue: Bool) -> Binding<Bool> {
        Binding(
            get: { configStore.draft?.log?[keyPath: keyPath] ?? defaultValue },
            set: { val in
                configStore.updateDraft {
                    $0.log = $0.log ?? LogConfig()
                    $0.log?[keyPath: keyPath] = val
                }
            }
        )
    }
}
