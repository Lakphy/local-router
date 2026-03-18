/**
 * SSE 流转换：将上游 provider 的 targetFormat 流转换为客户端期望的 sourceFormat 流。
 *
 * 每种转换方向实现一个 TransformStream<Uint8Array, Uint8Array>。
 */

import type { ProtocolFormat } from './convert-request';

interface AnyRecord {
  [key: string]: unknown;
}

// ─── 主入口 ───────────────────────────────────────────────────────────────────

/**
 * 创建 SSE 流转换 TransformStream。
 * @param source  客户端期望的格式
 * @param target  上游 provider 的格式
 * @param modelName  模型名称（用于生成事件）
 */
export function createStreamTransform(
  source: ProtocolFormat,
  target: ProtocolFormat,
  modelName: string,
): TransformStream<Uint8Array, Uint8Array> | null {
  if (source === target) return null;

  // target → source: 上游发 target 格式，需转换为 source 格式
  const key = `${target}->${source}`;
  switch (key) {
    case 'openai-completions->anthropic-messages':
      return createCompletionsToAnthropicStream(modelName);
    case 'anthropic-messages->openai-completions':
      return createAnthropicToCompletionsStream(modelName);
    case 'openai-responses->anthropic-messages':
      return createResponsesToAnthropicStream(modelName);
    case 'anthropic-messages->openai-responses':
      return createAnthropicToResponsesStream(modelName);
    case 'openai-completions->openai-responses':
      return createCompletionsToResponsesStream(modelName);
    case 'openai-responses->openai-completions':
      return createResponsesToCompletionsStream(modelName);
    default:
      return null;
  }
}

// ─── SSE 解析工具 ─────────────────────────────────────────────────────────────

interface SSEEvent {
  event: string;
  data: string;
}

class SSEParser {
  private buffer = '';

  feed(text: string): SSEEvent[] {
    this.buffer += text;
    const events: SSEEvent[] = [];

    while (true) {
      const idx = this.buffer.indexOf('\n\n');
      if (idx === -1) break;
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);

      let event = '';
      let data = '';

      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) {
          event = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          data += line.slice(6);
        } else if (line.startsWith(':')) {
          // 注释，忽略
        }
      }

      if (data) {
        events.push({ event, data });
      }
    }

    return events;
  }

  flush(): SSEEvent[] {
    if (!this.buffer.trim()) return [];
    // 处理末尾可能缺少 \n\n 的不完整事件
    const result = this.feed('\n\n');
    return result;
  }
}

function encodeSSE(data: string, event?: string): string {
  let result = '';
  if (event) result += `event: ${event}\n`;
  result += `data: ${data}\n\n`;
  return result;
}

function encodeSSEJson(obj: unknown, event?: string): string {
  return encodeSSE(JSON.stringify(obj), event);
}

// ─── OpenAI Completions Stream → Anthropic Messages Stream ───────────────────

function createCompletionsToAnthropicStream(
  modelName: string,
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  let messageStartSent = false;
  let contentBlockStartSent = false;
  let contentBlockIndex = 0;
  const msgId = `msg_${crypto.randomUUID()}`;
  let inputTokens = 0;
  let outputTokens = 0;

  // 处理 tool_calls 的累积状态
  let pendingToolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      const events = parser.feed(text);

      for (const sse of events) {
        if (sse.data === '[DONE]') {
          // 关闭所有未关闭的 content blocks
          if (contentBlockStartSent) {
            controller.enqueue(
              encoder.encode(encodeSSEJson({ type: 'content_block_stop', index: contentBlockIndex }, 'content_block_stop'))
            );
            contentBlockStartSent = false;
          }

          // 发送 message_delta + message_stop
          controller.enqueue(
            encoder.encode(
              encodeSSEJson(
                {
                  type: 'message_delta',
                  delta: { stop_reason: 'end_turn', stop_sequence: null },
                  usage: { output_tokens: outputTokens },
                },
                'message_delta',
              ),
            ),
          );
          controller.enqueue(
            encoder.encode(encodeSSEJson({ type: 'message_stop' }, 'message_stop')),
          );
          continue;
        }

        let data: AnyRecord;
        try {
          data = JSON.parse(sse.data) as AnyRecord;
        } catch {
          continue;
        }

        // 提取 usage
        if (data.usage) {
          const u = data.usage as AnyRecord;
          if (u.prompt_tokens != null) inputTokens = u.prompt_tokens as number;
          if (u.completion_tokens != null) outputTokens = u.completion_tokens as number;
        }

        const choices = (data.choices as AnyRecord[]) ?? [];
        const choice = choices[0];
        if (!choice) continue;

        const delta = (choice.delta ?? {}) as AnyRecord;
        const finishReason = choice.finish_reason as string | null;

        // 发送 message_start（首次）
        if (!messageStartSent) {
          controller.enqueue(
            encoder.encode(
              encodeSSEJson(
                {
                  type: 'message_start',
                  message: {
                    id: msgId,
                    type: 'message',
                    role: 'assistant',
                    model: (data.model as string) ?? modelName,
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: inputTokens, output_tokens: 0 },
                  },
                },
                'message_start',
              ),
            ),
          );
          messageStartSent = true;
        }

        // 处理 tool_calls delta
        if (delta.tool_calls) {
          const tcDeltas = delta.tool_calls as AnyRecord[];
          for (const tcDelta of tcDeltas) {
            const tcIndex = (tcDelta.index as number) ?? 0;
            const fn = tcDelta.function as AnyRecord | undefined;

            if (!pendingToolCalls.has(tcIndex)) {
              // 新 tool_call 开始，先关闭之前的 content block
              if (contentBlockStartSent) {
                controller.enqueue(
                  encoder.encode(encodeSSEJson({ type: 'content_block_stop', index: contentBlockIndex }, 'content_block_stop'))
                );
                contentBlockIndex++;
                contentBlockStartSent = false;
              }

              const toolId = (tcDelta.id as string) ?? `toolu_${contentBlockIndex}`;
              const toolName = (fn?.name as string) ?? '';
              pendingToolCalls.set(tcIndex, { id: toolId, name: toolName, arguments: '' });

              controller.enqueue(
                encoder.encode(
                  encodeSSEJson(
                    {
                      type: 'content_block_start',
                      index: contentBlockIndex,
                      content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
                    },
                    'content_block_start',
                  ),
                ),
              );
              contentBlockStartSent = true;
            }

            // 累积 arguments
            if (fn?.arguments) {
              const tc = pendingToolCalls.get(tcIndex)!;
              tc.arguments += fn.arguments as string;

              controller.enqueue(
                encoder.encode(
                  encodeSSEJson(
                    {
                      type: 'content_block_delta',
                      index: contentBlockIndex,
                      delta: { type: 'input_json_delta', partial_json: fn.arguments },
                    },
                    'content_block_delta',
                  ),
                ),
              );
            }
          }
          continue;
        }

        // 文本内容 delta
        if (delta.content != null) {
          if (!contentBlockStartSent) {
            controller.enqueue(
              encoder.encode(
                encodeSSEJson(
                  {
                    type: 'content_block_start',
                    index: contentBlockIndex,
                    content_block: { type: 'text', text: '' },
                  },
                  'content_block_start',
                ),
              ),
            );
            contentBlockStartSent = true;
          }

          controller.enqueue(
            encoder.encode(
              encodeSSEJson(
                {
                  type: 'content_block_delta',
                  index: contentBlockIndex,
                  delta: { type: 'text_delta', text: delta.content },
                },
                'content_block_delta',
              ),
            ),
          );
        }

        // finish_reason
        if (finishReason) {
          if (contentBlockStartSent) {
            controller.enqueue(
              encoder.encode(encodeSSEJson({ type: 'content_block_stop', index: contentBlockIndex }, 'content_block_stop'))
            );
            contentBlockStartSent = false;
          }

          let stopReason: string;
          if (finishReason === 'tool_calls') stopReason = 'tool_use';
          else if (finishReason === 'length') stopReason = 'max_tokens';
          else stopReason = 'end_turn';

          controller.enqueue(
            encoder.encode(
              encodeSSEJson(
                {
                  type: 'message_delta',
                  delta: { stop_reason: stopReason, stop_sequence: null },
                  usage: { output_tokens: outputTokens },
                },
                'message_delta',
              ),
            ),
          );
          controller.enqueue(
            encoder.encode(encodeSSEJson({ type: 'message_stop' }, 'message_stop')),
          );
        }
      }
    },

    flush(controller) {
      const remaining = parser.flush();
      // 通常不会有剩余，但确保 message_stop 已发送
      if (messageStartSent && remaining.length === 0) {
        // 如果还没发过 message_stop（异常中断），补发
      }
    },
  });
}

// ─── Anthropic Messages Stream → OpenAI Completions Stream ───────────────────

function createAnthropicToCompletionsStream(
  modelName: string,
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  const chatId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let firstChunkSent = false;
  let currentBlockType = '';
  let toolCallIndex = -1;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      const events = parser.feed(text);

      for (const sse of events) {
        let data: AnyRecord;
        try {
          data = JSON.parse(sse.data) as AnyRecord;
        } catch {
          continue;
        }

        const eventType = (data.type as string) ?? sse.event;

        switch (eventType) {
          case 'message_start': {
            const message = (data.message ?? {}) as AnyRecord;
            const model = (message.model as string) ?? modelName;
            // 发送第一个 chunk，包含 role
            controller.enqueue(
              encoder.encode(
                encodeSSE(
                  JSON.stringify({
                    id: chatId,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
                  }),
                ),
              ),
            );
            firstChunkSent = true;
            break;
          }

          case 'content_block_start': {
            const block = (data.content_block ?? {}) as AnyRecord;
            currentBlockType = (block.type as string) ?? 'text';

            if (currentBlockType === 'tool_use') {
              toolCallIndex++;
              controller.enqueue(
                encoder.encode(
                  encodeSSE(
                    JSON.stringify({
                      id: chatId,
                      object: 'chat.completion.chunk',
                      created,
                      model: modelName,
                      choices: [
                        {
                          index: 0,
                          delta: {
                            tool_calls: [
                              {
                                index: toolCallIndex,
                                id: block.id,
                                type: 'function',
                                function: { name: block.name, arguments: '' },
                              },
                            ],
                          },
                          finish_reason: null,
                        },
                      ],
                    }),
                  ),
                ),
              );
            }
            break;
          }

          case 'content_block_delta': {
            const delta = (data.delta ?? {}) as AnyRecord;

            if (delta.type === 'text_delta') {
              controller.enqueue(
                encoder.encode(
                  encodeSSE(
                    JSON.stringify({
                      id: chatId,
                      object: 'chat.completion.chunk',
                      created,
                      model: modelName,
                      choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
                    }),
                  ),
                ),
              );
            } else if (delta.type === 'input_json_delta') {
              controller.enqueue(
                encoder.encode(
                  encodeSSE(
                    JSON.stringify({
                      id: chatId,
                      object: 'chat.completion.chunk',
                      created,
                      model: modelName,
                      choices: [
                        {
                          index: 0,
                          delta: {
                            tool_calls: [
                              { index: toolCallIndex, function: { arguments: delta.partial_json } },
                            ],
                          },
                          finish_reason: null,
                        },
                      ],
                    }),
                  ),
                ),
              );
            }
            break;
          }

          case 'message_delta': {
            const delta = (data.delta ?? {}) as AnyRecord;
            const stopReason = delta.stop_reason as string | null;
            let finishReason: string;
            if (stopReason === 'end_turn') finishReason = 'stop';
            else if (stopReason === 'max_tokens') finishReason = 'length';
            else if (stopReason === 'tool_use') finishReason = 'tool_calls';
            else if (stopReason === 'stop_sequence') finishReason = 'stop';
            else finishReason = 'stop';

            const usage = (data.usage ?? {}) as AnyRecord;

            controller.enqueue(
              encoder.encode(
                encodeSSE(
                  JSON.stringify({
                    id: chatId,
                    object: 'chat.completion.chunk',
                    created,
                    model: modelName,
                    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                    ...(usage.output_tokens != null
                      ? { usage: { prompt_tokens: 0, completion_tokens: usage.output_tokens, total_tokens: usage.output_tokens } }
                      : {}),
                  }),
                ),
              ),
            );
            break;
          }

          case 'message_stop': {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            break;
          }

          // ping, content_block_stop 等忽略
          default:
            break;
        }
      }
    },

    flush(controller) {
      parser.flush();
    },
  });
}

// ─── OpenAI Responses Stream → Anthropic Messages Stream ─────────────────────

function createResponsesToAnthropicStream(
  modelName: string,
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  let messageSent = false;
  let contentBlockIndex = 0;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      const events = parser.feed(text);

      for (const sse of events) {
        if (sse.data === '[DONE]') continue;

        let data: AnyRecord;
        try {
          data = JSON.parse(sse.data) as AnyRecord;
        } catch {
          continue;
        }

        const eventType = (data.type as string) ?? sse.event;

        switch (eventType) {
          case 'response.created': {
            const resp = (data.response ?? data) as AnyRecord;
            if (!messageSent) {
              controller.enqueue(
                encoder.encode(
                  encodeSSEJson(
                    {
                      type: 'message_start',
                      message: {
                        id: (resp.id as string) ?? `msg_${crypto.randomUUID()}`,
                        type: 'message',
                        role: 'assistant',
                        model: (resp.model as string) ?? modelName,
                        content: [],
                        stop_reason: null,
                        stop_sequence: null,
                        usage: { input_tokens: 0, output_tokens: 0 },
                      },
                    },
                    'message_start',
                  ),
                ),
              );
              messageSent = true;
            }
            break;
          }

          case 'response.output_item.added': {
            const item = (data.item ?? {}) as AnyRecord;
            if (item.type === 'function_call') {
              controller.enqueue(
                encoder.encode(
                  encodeSSEJson(
                    {
                      type: 'content_block_start',
                      index: contentBlockIndex,
                      content_block: {
                        type: 'tool_use',
                        id: (item.call_id as string) ?? (item.id as string) ?? `toolu_${contentBlockIndex}`,
                        name: (item.name as string) ?? '',
                        input: {},
                      },
                    },
                    'content_block_start',
                  ),
                ),
              );
            }
            break;
          }

          case 'response.content_part.added': {
            const part = (data.part ?? {}) as AnyRecord;
            if (part.type === 'output_text') {
              controller.enqueue(
                encoder.encode(
                  encodeSSEJson(
                    {
                      type: 'content_block_start',
                      index: contentBlockIndex,
                      content_block: { type: 'text', text: '' },
                    },
                    'content_block_start',
                  ),
                ),
              );
            }
            break;
          }

          case 'response.output_text.delta': {
            const delta = (data.delta ?? '') as string;
            if (delta) {
              controller.enqueue(
                encoder.encode(
                  encodeSSEJson(
                    {
                      type: 'content_block_delta',
                      index: contentBlockIndex,
                      delta: { type: 'text_delta', text: delta },
                    },
                    'content_block_delta',
                  ),
                ),
              );
            }
            break;
          }

          case 'response.function_call_arguments.delta': {
            const delta = (data.delta ?? '') as string;
            if (delta) {
              controller.enqueue(
                encoder.encode(
                  encodeSSEJson(
                    {
                      type: 'content_block_delta',
                      index: contentBlockIndex,
                      delta: { type: 'input_json_delta', partial_json: delta },
                    },
                    'content_block_delta',
                  ),
                ),
              );
            }
            break;
          }

          case 'response.content_part.done':
          case 'response.function_call_arguments.done': {
            controller.enqueue(
              encoder.encode(
                encodeSSEJson({ type: 'content_block_stop', index: contentBlockIndex }, 'content_block_stop'),
              ),
            );
            contentBlockIndex++;
            break;
          }

          case 'response.completed': {
            const resp = (data.response ?? data) as AnyRecord;
            const usage = (resp.usage ?? {}) as AnyRecord;
            const output = resp.output as AnyRecord[] | undefined;
            const hasFunctionCall = output?.some((o) => o.type === 'function_call') ?? false;

            controller.enqueue(
              encoder.encode(
                encodeSSEJson(
                  {
                    type: 'message_delta',
                    delta: {
                      stop_reason: hasFunctionCall ? 'tool_use' : 'end_turn',
                      stop_sequence: null,
                    },
                    usage: { output_tokens: (usage.output_tokens as number) ?? 0 },
                  },
                  'message_delta',
                ),
              ),
            );
            controller.enqueue(
              encoder.encode(encodeSSEJson({ type: 'message_stop' }, 'message_stop')),
            );
            break;
          }

          default:
            break;
        }
      }
    },

    flush(controller) {
      parser.flush();
    },
  });
}

// ─── Anthropic Messages Stream → OpenAI Responses Stream ─────────────────────

function createAnthropicToResponsesStream(
  modelName: string,
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  const respId = `resp_${crypto.randomUUID()}`;
  let responseCreatedSent = false;
  let currentBlockType = '';
  let msgItemId = `msg_${crypto.randomUUID()}`;
  let outputItemIndex = 0;
  let contentPartIndex = 0;
  let fullText = '';

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      const events = parser.feed(text);

      for (const sse of events) {
        let data: AnyRecord;
        try {
          data = JSON.parse(sse.data) as AnyRecord;
        } catch {
          continue;
        }

        const eventType = (data.type as string) ?? sse.event;

        switch (eventType) {
          case 'message_start': {
            if (!responseCreatedSent) {
              const message = (data.message ?? {}) as AnyRecord;
              controller.enqueue(
                encoder.encode(
                  encodeSSE(
                    JSON.stringify({
                      type: 'response.created',
                      response: {
                        id: respId,
                        object: 'response',
                        created_at: Math.floor(Date.now() / 1000),
                        model: (message.model as string) ?? modelName,
                        status: 'in_progress',
                        output: [],
                      },
                    }),
                    'response.created',
                  ),
                ),
              );
              responseCreatedSent = true;
            }
            break;
          }

          case 'content_block_start': {
            const block = (data.content_block ?? {}) as AnyRecord;
            currentBlockType = (block.type as string) ?? 'text';

            if (currentBlockType === 'text') {
              // 发送 output_item.added (message) + content_part.added
              controller.enqueue(
                encoder.encode(
                  encodeSSE(
                    JSON.stringify({
                      type: 'response.output_item.added',
                      output_index: outputItemIndex,
                      item: {
                        type: 'message',
                        id: msgItemId,
                        role: 'assistant',
                        status: 'in_progress',
                        content: [],
                      },
                    }),
                    'response.output_item.added',
                  ),
                ),
              );
              controller.enqueue(
                encoder.encode(
                  encodeSSE(
                    JSON.stringify({
                      type: 'response.content_part.added',
                      item_id: msgItemId,
                      output_index: outputItemIndex,
                      content_index: contentPartIndex,
                      part: { type: 'output_text', text: '', annotations: [] },
                    }),
                    'response.content_part.added',
                  ),
                ),
              );
              fullText = '';
            } else if (currentBlockType === 'tool_use') {
              controller.enqueue(
                encoder.encode(
                  encodeSSE(
                    JSON.stringify({
                      type: 'response.output_item.added',
                      output_index: outputItemIndex,
                      item: {
                        type: 'function_call',
                        id: block.id,
                        call_id: block.id,
                        name: block.name,
                        arguments: '',
                        status: 'in_progress',
                      },
                    }),
                    'response.output_item.added',
                  ),
                ),
              );
            }
            break;
          }

          case 'content_block_delta': {
            const delta = (data.delta ?? {}) as AnyRecord;

            if (delta.type === 'text_delta') {
              const textDelta = (delta.text ?? '') as string;
              fullText += textDelta;
              controller.enqueue(
                encoder.encode(
                  encodeSSE(
                    JSON.stringify({
                      type: 'response.output_text.delta',
                      item_id: msgItemId,
                      output_index: outputItemIndex,
                      content_index: contentPartIndex,
                      delta: textDelta,
                    }),
                    'response.output_text.delta',
                  ),
                ),
              );
            } else if (delta.type === 'input_json_delta') {
              controller.enqueue(
                encoder.encode(
                  encodeSSE(
                    JSON.stringify({
                      type: 'response.function_call_arguments.delta',
                      output_index: outputItemIndex,
                      delta: delta.partial_json,
                    }),
                    'response.function_call_arguments.delta',
                  ),
                ),
              );
            }
            break;
          }

          case 'content_block_stop': {
            if (currentBlockType === 'text') {
              controller.enqueue(
                encoder.encode(
                  encodeSSE(
                    JSON.stringify({
                      type: 'response.output_text.done',
                      item_id: msgItemId,
                      output_index: outputItemIndex,
                      content_index: contentPartIndex,
                      text: fullText,
                    }),
                    'response.output_text.done',
                  ),
                ),
              );
              controller.enqueue(
                encoder.encode(
                  encodeSSE(
                    JSON.stringify({
                      type: 'response.content_part.done',
                      item_id: msgItemId,
                      output_index: outputItemIndex,
                      content_index: contentPartIndex,
                      part: { type: 'output_text', text: fullText, annotations: [] },
                    }),
                    'response.content_part.done',
                  ),
                ),
              );
              contentPartIndex++;
            } else if (currentBlockType === 'tool_use') {
              controller.enqueue(
                encoder.encode(
                  encodeSSE(
                    JSON.stringify({
                      type: 'response.function_call_arguments.done',
                      output_index: outputItemIndex,
                    }),
                    'response.function_call_arguments.done',
                  ),
                ),
              );
            }
            outputItemIndex++;
            break;
          }

          case 'message_delta': {
            // 不直接映射，等 message_stop 统一发 response.completed
            break;
          }

          case 'message_stop': {
            controller.enqueue(
              encoder.encode(
                encodeSSE(
                  JSON.stringify({
                    type: 'response.completed',
                    response: {
                      id: respId,
                      object: 'response',
                      created_at: Math.floor(Date.now() / 1000),
                      model: modelName,
                      status: 'completed',
                      output: [],
                    },
                  }),
                  'response.completed',
                ),
              ),
            );
            break;
          }

          default:
            break;
        }
      }
    },

    flush(controller) {
      parser.flush();
    },
  });
}

// ─── OpenAI Completions Stream → OpenAI Responses Stream ─────────────────────

function createCompletionsToResponsesStream(
  modelName: string,
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  const respId = `resp_${crypto.randomUUID()}`;
  const msgItemId = `msg_${crypto.randomUUID()}`;
  let responseCreatedSent = false;
  let contentPartAdded = false;
  let fullText = '';
  let outputItemIndex = 0;
  let toolCallIndex = -1;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      const events = parser.feed(text);

      for (const sse of events) {
        if (sse.data === '[DONE]') {
          // 发送 response.completed
          controller.enqueue(
            encoder.encode(
              encodeSSE(
                JSON.stringify({
                  type: 'response.completed',
                  response: {
                    id: respId,
                    object: 'response',
                    created_at: Math.floor(Date.now() / 1000),
                    model: modelName,
                    status: 'completed',
                    output: [],
                  },
                }),
                'response.completed',
              ),
            ),
          );
          continue;
        }

        let data: AnyRecord;
        try {
          data = JSON.parse(sse.data) as AnyRecord;
        } catch {
          continue;
        }

        const choices = (data.choices as AnyRecord[]) ?? [];
        const choice = choices[0];
        if (!choice) continue;

        const delta = (choice.delta ?? {}) as AnyRecord;
        const finishReason = choice.finish_reason as string | null;

        // 发送 response.created
        if (!responseCreatedSent) {
          controller.enqueue(
            encoder.encode(
              encodeSSE(
                JSON.stringify({
                  type: 'response.created',
                  response: {
                    id: respId,
                    object: 'response',
                    created_at: (data.created as number) ?? Math.floor(Date.now() / 1000),
                    model: (data.model as string) ?? modelName,
                    status: 'in_progress',
                    output: [],
                  },
                }),
                'response.created',
              ),
            ),
          );
          responseCreatedSent = true;
        }

        // 文本内容
        if (delta.content != null) {
          if (!contentPartAdded) {
            // 发送 output_item.added + content_part.added
            controller.enqueue(
              encoder.encode(
                encodeSSE(
                  JSON.stringify({
                    type: 'response.output_item.added',
                    output_index: outputItemIndex,
                    item: { type: 'message', id: msgItemId, role: 'assistant', status: 'in_progress', content: [] },
                  }),
                  'response.output_item.added',
                ),
              ),
            );
            controller.enqueue(
              encoder.encode(
                encodeSSE(
                  JSON.stringify({
                    type: 'response.content_part.added',
                    item_id: msgItemId,
                    output_index: outputItemIndex,
                    content_index: 0,
                    part: { type: 'output_text', text: '', annotations: [] },
                  }),
                  'response.content_part.added',
                ),
              ),
            );
            contentPartAdded = true;
          }

          fullText += delta.content as string;
          controller.enqueue(
            encoder.encode(
              encodeSSE(
                JSON.stringify({
                  type: 'response.output_text.delta',
                  item_id: msgItemId,
                  output_index: outputItemIndex,
                  content_index: 0,
                  delta: delta.content,
                }),
                'response.output_text.delta',
              ),
            ),
          );
        }

        // tool_calls
        if (delta.tool_calls) {
          const tcDeltas = delta.tool_calls as AnyRecord[];
          for (const tcDelta of tcDeltas) {
            const tcIdx = (tcDelta.index as number) ?? 0;
            const fn = tcDelta.function as AnyRecord | undefined;

            if (tcIdx > toolCallIndex) {
              // 新 tool_call
              if (contentPartAdded) {
                // 关闭 text content
                controller.enqueue(
                  encoder.encode(
                    encodeSSE(JSON.stringify({ type: 'response.output_text.done', text: fullText }), 'response.output_text.done'),
                  ),
                );
                controller.enqueue(
                  encoder.encode(
                    encodeSSE(
                      JSON.stringify({ type: 'response.content_part.done', part: { type: 'output_text', text: fullText, annotations: [] } }),
                      'response.content_part.done',
                    ),
                  ),
                );
                outputItemIndex++;
                contentPartAdded = false;
              }
              toolCallIndex = tcIdx;
              controller.enqueue(
                encoder.encode(
                  encodeSSE(
                    JSON.stringify({
                      type: 'response.output_item.added',
                      output_index: outputItemIndex,
                      item: {
                        type: 'function_call',
                        id: tcDelta.id,
                        call_id: tcDelta.id,
                        name: fn?.name ?? '',
                        arguments: '',
                        status: 'in_progress',
                      },
                    }),
                    'response.output_item.added',
                  ),
                ),
              );
            }

            if (fn?.arguments) {
              controller.enqueue(
                encoder.encode(
                  encodeSSE(
                    JSON.stringify({
                      type: 'response.function_call_arguments.delta',
                      output_index: outputItemIndex,
                      delta: fn.arguments,
                    }),
                    'response.function_call_arguments.delta',
                  ),
                ),
              );
            }
          }
        }

        // finish
        if (finishReason) {
          if (contentPartAdded) {
            controller.enqueue(
              encoder.encode(
                encodeSSE(JSON.stringify({ type: 'response.output_text.done', text: fullText }), 'response.output_text.done'),
              ),
            );
            controller.enqueue(
              encoder.encode(
                encodeSSE(
                  JSON.stringify({ type: 'response.content_part.done', part: { type: 'output_text', text: fullText, annotations: [] } }),
                  'response.content_part.done',
                ),
              ),
            );
          }
        }
      }
    },

    flush(controller) {
      parser.flush();
    },
  });
}

// ─── OpenAI Responses Stream → OpenAI Completions Stream ─────────────────────

function createResponsesToCompletionsStream(
  modelName: string,
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  const chatId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let firstChunkSent = false;
  let toolCallIndex = -1;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      const events = parser.feed(text);

      for (const sse of events) {
        if (sse.data === '[DONE]') continue;

        let data: AnyRecord;
        try {
          data = JSON.parse(sse.data) as AnyRecord;
        } catch {
          continue;
        }

        const eventType = (data.type as string) ?? sse.event;

        switch (eventType) {
          case 'response.created': {
            if (!firstChunkSent) {
              const resp = (data.response ?? data) as AnyRecord;
              controller.enqueue(
                encoder.encode(
                  encodeSSE(
                    JSON.stringify({
                      id: chatId,
                      object: 'chat.completion.chunk',
                      created,
                      model: (resp.model as string) ?? modelName,
                      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
                    }),
                  ),
                ),
              );
              firstChunkSent = true;
            }
            break;
          }

          case 'response.output_item.added': {
            const item = (data.item ?? {}) as AnyRecord;
            if (item.type === 'function_call') {
              toolCallIndex++;
              controller.enqueue(
                encoder.encode(
                  encodeSSE(
                    JSON.stringify({
                      id: chatId,
                      object: 'chat.completion.chunk',
                      created,
                      model: modelName,
                      choices: [
                        {
                          index: 0,
                          delta: {
                            tool_calls: [
                              {
                                index: toolCallIndex,
                                id: item.call_id ?? item.id,
                                type: 'function',
                                function: { name: item.name ?? '', arguments: '' },
                              },
                            ],
                          },
                          finish_reason: null,
                        },
                      ],
                    }),
                  ),
                ),
              );
            }
            break;
          }

          case 'response.output_text.delta': {
            const delta = (data.delta ?? '') as string;
            if (delta) {
              controller.enqueue(
                encoder.encode(
                  encodeSSE(
                    JSON.stringify({
                      id: chatId,
                      object: 'chat.completion.chunk',
                      created,
                      model: modelName,
                      choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
                    }),
                  ),
                ),
              );
            }
            break;
          }

          case 'response.function_call_arguments.delta': {
            const delta = (data.delta ?? '') as string;
            if (delta) {
              controller.enqueue(
                encoder.encode(
                  encodeSSE(
                    JSON.stringify({
                      id: chatId,
                      object: 'chat.completion.chunk',
                      created,
                      model: modelName,
                      choices: [
                        {
                          index: 0,
                          delta: {
                            tool_calls: [{ index: toolCallIndex, function: { arguments: delta } }],
                          },
                          finish_reason: null,
                        },
                      ],
                    }),
                  ),
                ),
              );
            }
            break;
          }

          case 'response.completed': {
            const resp = (data.response ?? data) as AnyRecord;
            const output = resp.output as AnyRecord[] | undefined;
            const hasFunctionCall = output?.some((o) => o.type === 'function_call') ?? false;
            const finishReason = hasFunctionCall ? 'tool_calls' : 'stop';

            controller.enqueue(
              encoder.encode(
                encodeSSE(
                  JSON.stringify({
                    id: chatId,
                    object: 'chat.completion.chunk',
                    created,
                    model: (resp.model as string) ?? modelName,
                    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                  }),
                ),
              ),
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            break;
          }

          default:
            break;
        }
      }
    },

    flush(controller) {
      parser.flush();
    },
  });
}
