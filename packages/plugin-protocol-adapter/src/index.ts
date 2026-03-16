/**
 * 协议适配器插件：Anthropic Messages ↔ OpenAI Responses
 *
 * 用途：将 openai-responses 类型的 provider 挂载到 anthropic-messages 路由上，
 * 使用户可以用 Anthropic Messages 协议访问 OpenAI Responses 后端。
 *
 * 转换方向：
 *   请求：Anthropic Messages → OpenAI Responses（正向，发往 provider）
 *   响应：OpenAI Responses → Anthropic Messages（逆向，返回客户端）
 */
import type { PluginDefinition, Plugin, PluginContext } from '../../../src/plugin';

// ─── 类型定义 ────────────────────────────────────────────────────────────────

interface AdapterParams {
  /** 保留，未来可扩展为支持多种协议对 */
  direction?: 'anthropic-to-openai-responses';
}

// Anthropic Messages 请求体字段
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: string;
  [key: string]: unknown;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicToolChoice {
  type: 'auto' | 'any' | 'tool';
  name?: string;
  disable_parallel_tool_use?: boolean;
}

// OpenAI Responses 请求体字段
interface OpenAIResponsesRequest {
  model: string;
  input: string | OpenAIInputItem[];
  instructions?: string;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: OpenAITool[];
  tool_choice?: string | { type: string; name?: string };
  [key: string]: unknown;
}

interface OpenAIInputItem {
  type?: string;
  role?: string;
  content?: string | OpenAIContentPart[];
  call_id?: string;
  output?: string;
  name?: string;
  arguments?: string;
  id?: string;
  [key: string]: unknown;
}

interface OpenAIContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface OpenAITool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

// ─── 请求转换：Anthropic → OpenAI Responses ─────────────────────────────────

function convertAnthropicContentToOpenAI(
  content: string | AnthropicContentBlock[],
  role: 'user' | 'assistant'
): string | OpenAIContentPart[] {
  if (typeof content === 'string') return content;

  const parts: OpenAIContentPart[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({
        type: role === 'user' ? 'input_text' : 'output_text',
        text: block.text as string,
      });
    } else if (block.type === 'image') {
      // Anthropic: { type: "image", source: { type: "base64", media_type, data } }
      const source = block.source as { type: string; media_type?: string; data?: string; url?: string };
      if (source?.type === 'base64' && source.media_type && source.data) {
        parts.push({
          type: 'input_image',
          image_url: `data:${source.media_type};base64,${source.data}`,
        });
      } else if (source?.type === 'url' && source.url) {
        parts.push({ type: 'input_image', image_url: source.url });
      }
    }
    // tool_use 和 tool_result 在消息级别处理，此处跳过
  }
  return parts.length > 0 ? parts : '';
}

function convertMessagesToInput(messages: AnthropicMessage[]): OpenAIInputItem[] {
  const input: OpenAIInputItem[] = [];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      input.push({ role: msg.role, content: msg.content });
      continue;
    }

    // 处理数组内容
    const textAndImageParts: AnthropicContentBlock[] = [];
    const toolUseParts: AnthropicContentBlock[] = [];
    const toolResultParts: AnthropicContentBlock[] = [];

    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        toolUseParts.push(block);
      } else if (block.type === 'tool_result') {
        toolResultParts.push(block);
      } else {
        textAndImageParts.push(block);
      }
    }

    // 先添加文本/图片内容
    if (textAndImageParts.length > 0) {
      const converted = convertAnthropicContentToOpenAI(textAndImageParts, msg.role);
      if (converted) {
        input.push({ role: msg.role, content: converted });
      }
    } else if (toolUseParts.length === 0 && toolResultParts.length === 0) {
      // 空内容
      input.push({ role: msg.role, content: '' });
    }

    // assistant 消息中的 tool_use → function_call 输入项
    for (const tu of toolUseParts) {
      input.push({
        type: 'function_call',
        call_id: tu.id as string,
        name: tu.name as string,
        arguments: JSON.stringify(tu.input ?? {}),
      });
    }

    // user 消息中的 tool_result → function_call_output 输入项
    for (const tr of toolResultParts) {
      let outputStr: string;
      if (typeof tr.content === 'string') {
        outputStr = tr.content;
      } else if (Array.isArray(tr.content)) {
        outputStr = (tr.content as AnthropicContentBlock[])
          .filter((b) => b.type === 'text')
          .map((b) => b.text as string)
          .join('\n');
      } else {
        outputStr = JSON.stringify(tr.content ?? '');
      }
      input.push({
        type: 'function_call_output',
        call_id: tr.tool_use_id as string,
        output: outputStr,
      });
    }
  }

  return input;
}

function convertTools(tools: AnthropicTool[]): OpenAITool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));
}

function convertToolChoice(
  tc: AnthropicToolChoice
): string | { type: string; name?: string } {
  switch (tc.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'tool':
      return { type: 'function', name: tc.name };
    default:
      return 'auto';
  }
}

function convertRequest(body: Record<string, unknown>): Record<string, unknown> {
  const req = body as unknown as AnthropicRequest;
  const result: OpenAIResponsesRequest = {
    model: req.model,
    input: convertMessagesToInput(req.messages),
    stream: req.stream,
  };

  // system → instructions
  if (req.system) {
    if (typeof req.system === 'string') {
      result.instructions = req.system;
    } else if (Array.isArray(req.system)) {
      result.instructions = req.system
        .filter((b) => b.type === 'text')
        .map((b) => b.text as string)
        .join('\n');
    }
  }

  // max_tokens → max_output_tokens
  if (req.max_tokens != null) {
    result.max_output_tokens = req.max_tokens;
  }

  // 直接传递的参数
  if (req.temperature != null) result.temperature = req.temperature;
  if (req.top_p != null) result.top_p = req.top_p;
  // top_k 在 OpenAI 中不支持，忽略

  // tools
  if (req.tools && req.tools.length > 0) {
    result.tools = convertTools(req.tools);
  }

  // tool_choice
  if (req.tool_choice) {
    result.tool_choice = convertToolChoice(req.tool_choice);
  }

  return result as unknown as Record<string, unknown>;
}

// ─── 响应转换：OpenAI Responses → Anthropic Messages ─────────────────────────

interface OpenAIResponse {
  id: string;
  object?: string;
  created_at?: number;
  model: string;
  output: OpenAIOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens?: number;
    [key: string]: unknown;
  };
  status: string;
  incomplete_details?: unknown;
  [key: string]: unknown;
}

interface OpenAIOutputItem {
  type: string;
  id?: string;
  role?: string;
  status?: string;
  content?: { type: string; text?: string; annotations?: unknown[] }[];
  // function_call 类型
  call_id?: string;
  name?: string;
  arguments?: string;
  [key: string]: unknown;
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicResponseContent[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

interface AnthropicResponseContent {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

function convertResponse(bodyStr: string): string {
  let resp: OpenAIResponse;
  try {
    resp = JSON.parse(bodyStr) as OpenAIResponse;
  } catch {
    return bodyStr; // 无法解析则原样返回
  }

  if (!resp.output) return bodyStr;

  const content: AnthropicResponseContent[] = [];
  let hasToolUse = false;

  for (const item of resp.output) {
    if (item.type === 'message' && item.content) {
      for (const part of item.content) {
        if (part.type === 'output_text' && part.text != null) {
          content.push({ type: 'text', text: part.text });
        }
      }
    } else if (item.type === 'function_call') {
      hasToolUse = true;
      let parsedInput: unknown = {};
      try {
        parsedInput = JSON.parse(item.arguments ?? '{}');
      } catch {
        parsedInput = {};
      }
      content.push({
        type: 'tool_use',
        id: item.call_id ?? item.id ?? `toolu_${crypto.randomUUID()}`,
        name: item.name ?? 'unknown',
        input: parsedInput,
      });
    }
  }

  // stop_reason 映射
  let stopReason: string;
  if (hasToolUse) {
    stopReason = 'tool_use';
  } else if (resp.status === 'completed') {
    stopReason = 'end_turn';
  } else if (resp.status === 'incomplete') {
    stopReason = 'max_tokens';
  } else {
    stopReason = 'end_turn';
  }

  const result: AnthropicResponse = {
    id: resp.id,
    type: 'message',
    role: 'assistant',
    model: resp.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.input_tokens ?? 0,
      output_tokens: resp.usage?.output_tokens ?? 0,
    },
  };

  return JSON.stringify(result);
}

// ─── SSE 流转换：OpenAI Responses → Anthropic Messages ───────────────────────

function createSSETransform(ctx: PluginContext): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentBlockIndex = 0;
  let messageSent = false;
  let modelName = ctx.modelOut;

  function emit(controller: TransformStreamDefaultController<Uint8Array>, eventType: string, data: unknown) {
    const line = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    controller.enqueue(encoder.encode(line));
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      // 保留最后一行（可能不完整）
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith('data: ')) continue;

        const jsonStr = trimmed.slice(6);
        if (jsonStr === '[DONE]') continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(jsonStr) as Record<string, unknown>;
        } catch {
          continue;
        }

        const eventType = event.type as string;

        switch (eventType) {
          case 'response.created': {
            // 发送 message_start
            const resp = event.response as Record<string, unknown>;
            modelName = (resp?.model as string) ?? modelName;
            if (!messageSent) {
              emit(controller, 'message_start', {
                type: 'message_start',
                message: {
                  id: resp?.id ?? `msg_${crypto.randomUUID()}`,
                  type: 'message',
                  role: 'assistant',
                  model: modelName,
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 0, output_tokens: 0 },
                },
              });
              messageSent = true;
            }
            break;
          }

          case 'response.output_item.added': {
            const item = event.item as Record<string, unknown>;
            if (item?.type === 'function_call') {
              // function_call → content_block_start (tool_use)
              emit(controller, 'content_block_start', {
                type: 'content_block_start',
                index: contentBlockIndex,
                content_block: {
                  type: 'tool_use',
                  id: (item.call_id as string) ?? (item.id as string) ?? `toolu_${contentBlockIndex}`,
                  name: (item.name as string) ?? '',
                  input: {},
                },
              });
            }
            // message 类型在 content_part.added 时再发 content_block_start
            break;
          }

          case 'response.content_part.added': {
            const part = event.part as Record<string, unknown>;
            if (part?.type === 'output_text') {
              emit(controller, 'content_block_start', {
                type: 'content_block_start',
                index: contentBlockIndex,
                content_block: { type: 'text', text: '' },
              });
            }
            break;
          }

          case 'response.output_text.delta': {
            const delta = event.delta as string;
            if (delta != null) {
              emit(controller, 'content_block_delta', {
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: { type: 'text_delta', text: delta },
              });
            }
            break;
          }

          case 'response.function_call_arguments.delta': {
            const delta = event.delta as string;
            if (delta != null) {
              emit(controller, 'content_block_delta', {
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: { type: 'input_json_delta', partial_json: delta },
              });
            }
            break;
          }

          case 'response.content_part.done':
          case 'response.function_call_arguments.done': {
            emit(controller, 'content_block_stop', {
              type: 'content_block_stop',
              index: contentBlockIndex,
            });
            contentBlockIndex++;
            break;
          }

          case 'response.output_item.done': {
            // 如果是 function_call 且尚未发 content_block_stop，补发
            // 通常已在 function_call_arguments.done 处理，此处跳过
            break;
          }

          case 'response.completed': {
            const resp = event.response as Record<string, unknown>;
            const usage = resp?.usage as Record<string, unknown> | undefined;
            const outputTokens = (usage?.output_tokens as number) ?? 0;

            // 检查是否有 function_call 输出
            const output = resp?.output as Record<string, unknown>[] | undefined;
            const hasFunctionCall = output?.some((o) => o.type === 'function_call') ?? false;

            emit(controller, 'message_delta', {
              type: 'message_delta',
              delta: {
                stop_reason: hasFunctionCall ? 'tool_use' : 'end_turn',
                stop_sequence: null,
              },
              usage: { output_tokens: outputTokens },
            });

            emit(controller, 'message_stop', { type: 'message_stop' });
            break;
          }

          case 'response.in_progress':
          case 'response.failed':
            // 忽略这些事件
            break;

          default:
            // 未知事件类型，忽略
            break;
        }
      }
    },

    flush(controller) {
      // 处理缓冲区中剩余数据
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith('data: ') && trimmed.slice(6) !== '[DONE]') {
          // 尝试解析最后一行
          try {
            const event = JSON.parse(trimmed.slice(6)) as Record<string, unknown>;
            if (event.type === 'response.completed') {
              const resp = event.response as Record<string, unknown>;
              const usage = resp?.usage as Record<string, unknown> | undefined;
              emit(controller, 'message_delta', {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: (usage?.output_tokens as number) ?? 0 },
              });
              emit(controller, 'message_stop', { type: 'message_stop' });
            }
          } catch {
            // 忽略
          }
        }
      }

      // 确保发送了 message_stop
      if (messageSent) {
        // message_stop 已在 response.completed 中发送
      }
    },
  });
}

// ─── 插件定义 ─────────────────────────────────────────────────────────────────

const definition: PluginDefinition = {
  name: 'protocol-adapter',
  version: '0.1.0',

  create(params: Record<string, unknown>): Plugin {
    const _params = params as AdapterParams;

    return {
      async onRequest({ ctx, url, headers, body }) {
        // 仅在 anthropic-messages 路由时执行转换
        if (ctx.routeType !== 'anthropic-messages') return;

        // 1. 转换 URL：/v1/messages → /v1/responses
        const newUrl = url.replace(/\/v1\/messages\b/, '/v1/responses');

        // 2. 转换认证头：x-api-key → Authorization: Bearer
        const apiKey = headers.get('x-api-key');
        if (apiKey) {
          headers.delete('x-api-key');
          headers.set('Authorization', `Bearer ${apiKey}`);
        }

        // 3. 移除 Anthropic 特有的头
        headers.delete('anthropic-version');
        headers.delete('anthropic-beta');

        // 4. 转换请求体
        const newBody = convertRequest(body);

        return { url: newUrl, headers, body: newBody };
      },

      async onResponse({ ctx, status, headers, body }) {
        if (ctx.routeType !== 'anthropic-messages') return;

        // 转换响应体：OpenAI Responses → Anthropic Messages
        const newBody = convertResponse(body);

        return { status, headers, body: newBody };
      },

      async onSSEResponse({ ctx, status, headers }) {
        if (ctx.routeType !== 'anthropic-messages') return;

        // 返回 TransformStream 进行 SSE 事件格式转换
        const transform = createSSETransform(ctx);

        return { status, headers, transform };
      },

      async onError({ ctx, phase, error }) {
        console.error(
          `[plugin:protocol-adapter] onError phase=${phase} provider=${ctx.provider}: ${error.message}`
        );
      },

      dispose() {
        // 无状态插件，无需清理
      },
    };
  },
};

export default definition;
