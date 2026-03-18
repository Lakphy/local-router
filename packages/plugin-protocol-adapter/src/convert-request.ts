/**
 * 请求体格式转换：支持三种协议之间的互转。
 *
 * 方向：将客户端发送的 sourceFormat 请求体转换为上游 provider 期望的 targetFormat。
 */

export type ProtocolFormat =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages';

// ─── 通用类型 ─────────────────────────────────────────────────────────────────

interface AnyRecord {
  [key: string]: unknown;
}

// ─── 主入口 ───────────────────────────────────────────────────────────────────

export function convertRequestBody(
  body: Record<string, unknown>,
  from: ProtocolFormat,
  to: ProtocolFormat,
): Record<string, unknown> {
  if (from === to) return body;

  const key = `${from}->${to}`;
  switch (key) {
    case 'anthropic-messages->openai-completions':
      return anthropicToCompletions(body);
    case 'anthropic-messages->openai-responses':
      return anthropicToResponses(body);
    case 'openai-completions->anthropic-messages':
      return completionsToAnthropic(body);
    case 'openai-completions->openai-responses':
      return completionsToResponses(body);
    case 'openai-responses->anthropic-messages':
      return responsesToAnthropic(body);
    case 'openai-responses->openai-completions':
      return responsesToCompletions(body);
    default:
      return body;
  }
}

// ─── Anthropic → OpenAI Completions ──────────────────────────────────────────

function anthropicToCompletions(body: AnyRecord): AnyRecord {
  const messages: AnyRecord[] = [];

  // system → system message
  if (body.system) {
    const systemText =
      typeof body.system === 'string'
        ? body.system
        : (body.system as AnyRecord[])
            .filter((b) => b.type === 'text')
            .map((b) => b.text as string)
            .join('\n');
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }
  }

  // messages 转换
  const srcMessages = (body.messages as AnyRecord[]) ?? [];
  for (const msg of srcMessages) {
    const role = msg.role as string;
    const content = msg.content;

    if (typeof content === 'string') {
      messages.push({ role, content });
      continue;
    }

    if (!Array.isArray(content)) {
      messages.push({ role, content: '' });
      continue;
    }

    const blocks = content as AnyRecord[];
    const textImageParts: AnyRecord[] = [];
    const toolUseParts: AnyRecord[] = [];
    const toolResultParts: AnyRecord[] = [];

    for (const block of blocks) {
      if (block.type === 'tool_use') toolUseParts.push(block);
      else if (block.type === 'tool_result') toolResultParts.push(block);
      else textImageParts.push(block);
    }

    // 文本/图片内容
    if (textImageParts.length > 0) {
      const parts = convertAnthropicBlocksToCompletionsParts(textImageParts);
      // 如果 assistant 消息同时有文本和 tool_use，合并到一个消息
      if (toolUseParts.length > 0 && role === 'assistant') {
        const toolCalls = toolUseParts.map((tu) => ({
          id: tu.id,
          type: 'function',
          function: {
            name: tu.name,
            arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input ?? {}),
          },
        }));
        const textContent =
          parts.length === 1 && typeof parts[0] === 'string'
            ? parts[0]
            : parts.length === 1 && parts[0]?.type === 'text'
              ? (parts[0] as AnyRecord).text
              : parts
                  .filter((p: AnyRecord) => p.type === 'text')
                  .map((p: AnyRecord) => p.text)
                  .join('');
        messages.push({ role: 'assistant', content: textContent || null, tool_calls: toolCalls });
      } else {
        const content = simplifyCompletionsParts(parts);
        messages.push({ role, content });
      }
    } else if (toolUseParts.length > 0 && role === 'assistant') {
      // 仅 tool_use，无文本
      const toolCalls = toolUseParts.map((tu) => ({
        id: tu.id,
        type: 'function',
        function: {
          name: tu.name,
          arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input ?? {}),
        },
      }));
      messages.push({ role: 'assistant', content: null, tool_calls: toolCalls });
    }

    // tool_result → 独立的 tool messages
    for (const tr of toolResultParts) {
      let resultContent: string;
      if (typeof tr.content === 'string') {
        resultContent = tr.content;
      } else if (Array.isArray(tr.content)) {
        resultContent = (tr.content as AnyRecord[])
          .filter((b) => b.type === 'text')
          .map((b) => b.text as string)
          .join('\n');
      } else {
        resultContent = JSON.stringify(tr.content ?? '');
      }
      messages.push({
        role: 'tool',
        tool_call_id: tr.tool_use_id,
        content: resultContent,
      });
    }
  }

  const result: AnyRecord = { model: body.model, messages };

  if (body.max_tokens != null) result.max_tokens = body.max_tokens;
  if (body.temperature != null) result.temperature = body.temperature;
  if (body.top_p != null) result.top_p = body.top_p;
  if (body.stream != null) result.stream = body.stream;
  if (body.stop_sequences != null) result.stop = body.stop_sequences;
  if (body.tools) {
    result.tools = (body.tools as AnyRecord[]).map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice as AnyRecord;
    if (tc.type === 'auto') result.tool_choice = 'auto';
    else if (tc.type === 'any') result.tool_choice = 'required';
    else if (tc.type === 'tool') result.tool_choice = { type: 'function', function: { name: tc.name } };
  }
  // stream_options for stream usage
  if (body.stream === true) {
    result.stream_options = { include_usage: true };
  }

  return result;
}

function convertAnthropicBlocksToCompletionsParts(blocks: AnyRecord[]): AnyRecord[] {
  const parts: AnyRecord[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      const source = block.source as AnyRecord | undefined;
      if (source?.type === 'base64' && source.media_type && source.data) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${source.media_type};base64,${source.data}` },
        });
      } else if (source?.type === 'url' && source.url) {
        parts.push({ type: 'image_url', image_url: { url: source.url } });
      }
    }
    // thinking 等类型忽略
  }
  return parts;
}

function simplifyCompletionsParts(parts: AnyRecord[]): string | AnyRecord[] {
  if (parts.length === 1 && parts[0].type === 'text') {
    return parts[0].text as string;
  }
  return parts;
}

// ─── OpenAI Completions → Anthropic ──────────────────────────────────────────

function completionsToAnthropic(body: AnyRecord): AnyRecord {
  const srcMessages = (body.messages as AnyRecord[]) ?? [];
  let system: string | undefined;
  const messages: AnyRecord[] = [];

  for (const msg of srcMessages) {
    const role = msg.role as string;

    if (role === 'system') {
      // 系统消息提取到 system 字段
      const text = typeof msg.content === 'string' ? msg.content : contentPartsToText(msg.content as AnyRecord[]);
      system = system ? `${system}\n${text}` : text;
      continue;
    }

    if (role === 'tool') {
      // tool response → user message with tool_result
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          },
        ],
      });
      continue;
    }

    // user / assistant
    const content = msg.content;
    const toolCalls = msg.tool_calls as AnyRecord[] | undefined;

    const blocks: AnyRecord[] = [];

    if (typeof content === 'string') {
      if (content) blocks.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      for (const part of content as AnyRecord[]) {
        if (part.type === 'text') {
          blocks.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
          const imageUrl = part.image_url as AnyRecord;
          const url = (imageUrl?.url ?? '') as string;
          if (url.startsWith('data:')) {
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              blocks.push({
                type: 'image',
                source: { type: 'base64', media_type: match[1], data: match[2] },
              });
            }
          } else {
            blocks.push({ type: 'image', source: { type: 'url', url } });
          }
        }
      }
    }

    // tool_calls → tool_use blocks
    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        const fn = tc.function as AnyRecord | undefined;
        let input: unknown = {};
        try {
          input = JSON.parse((fn?.arguments as string) ?? '{}');
        } catch {
          input = {};
        }
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: fn?.name,
          input,
        });
      }
    }

    if (blocks.length > 0) {
      messages.push({ role, content: blocks });
    } else {
      // 空消息也保留，避免消息丢失
      messages.push({ role, content: [{ type: 'text', text: '' }] });
    }
  }

  const result: AnyRecord = { model: body.model, messages };
  if (system) result.system = system;
  if (body.max_tokens != null) result.max_tokens = body.max_tokens;
  else result.max_tokens = 4096; // Anthropic 要求 max_tokens 必填
  if (body.temperature != null) result.temperature = body.temperature;
  if (body.top_p != null) result.top_p = body.top_p;
  if (body.stream != null) result.stream = body.stream;
  if (body.stop != null) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.tools) {
    result.tools = (body.tools as AnyRecord[]).map((t) => {
      const fn = (t.function ?? t) as AnyRecord;
      return { name: fn.name, description: fn.description, input_schema: fn.parameters ?? {} };
    });
  }
  if (body.tool_choice) {
    if (body.tool_choice === 'auto') result.tool_choice = { type: 'auto' };
    else if (body.tool_choice === 'required') result.tool_choice = { type: 'any' };
    else if (body.tool_choice === 'none') {
      // Anthropic 没有 none，不传 tool_choice
    } else if (typeof body.tool_choice === 'object') {
      const tc = body.tool_choice as AnyRecord;
      const fn = tc.function as AnyRecord | undefined;
      if (fn?.name) result.tool_choice = { type: 'tool', name: fn.name };
    }
  }

  return result;
}

function contentPartsToText(parts: AnyRecord[]): string {
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text as string)
    .join('\n');
}

// ─── Anthropic → OpenAI Responses ────────────────────────────────────────────

function anthropicToResponses(body: AnyRecord): AnyRecord {
  const input: AnyRecord[] = [];
  const srcMessages = (body.messages as AnyRecord[]) ?? [];

  for (const msg of srcMessages) {
    const role = msg.role as string;
    const content = msg.content;

    if (typeof content === 'string') {
      input.push({ role, content });
      continue;
    }

    if (!Array.isArray(content)) {
      input.push({ role, content: '' });
      continue;
    }

    const blocks = content as AnyRecord[];
    const textImageParts: AnyRecord[] = [];
    const toolUseParts: AnyRecord[] = [];
    const toolResultParts: AnyRecord[] = [];

    for (const block of blocks) {
      if (block.type === 'tool_use') toolUseParts.push(block);
      else if (block.type === 'tool_result') toolResultParts.push(block);
      else textImageParts.push(block);
    }

    if (textImageParts.length > 0) {
      const parts = convertAnthropicBlocksToResponsesParts(textImageParts, role);
      if (parts.length > 0) {
        input.push({ role, content: parts });
      }
    }

    for (const tu of toolUseParts) {
      input.push({
        type: 'function_call',
        call_id: tu.id,
        name: tu.name,
        arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input ?? {}),
      });
    }

    for (const tr of toolResultParts) {
      let outputStr: string;
      if (typeof tr.content === 'string') {
        outputStr = tr.content;
      } else if (Array.isArray(tr.content)) {
        outputStr = (tr.content as AnyRecord[])
          .filter((b) => b.type === 'text')
          .map((b) => b.text as string)
          .join('\n');
      } else {
        outputStr = JSON.stringify(tr.content ?? '');
      }
      input.push({ type: 'function_call_output', call_id: tr.tool_use_id, output: outputStr });
    }
  }

  const result: AnyRecord = { model: body.model, input, stream: body.stream };

  if (body.system) {
    result.instructions =
      typeof body.system === 'string'
        ? body.system
        : (body.system as AnyRecord[])
            .filter((b) => b.type === 'text')
            .map((b) => b.text as string)
            .join('\n');
  }
  if (body.max_tokens != null) result.max_output_tokens = body.max_tokens;
  if (body.temperature != null) result.temperature = body.temperature;
  if (body.top_p != null) result.top_p = body.top_p;
  if (body.tools) {
    result.tools = (body.tools as AnyRecord[]).map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice as AnyRecord;
    if (tc.type === 'auto') result.tool_choice = 'auto';
    else if (tc.type === 'any') result.tool_choice = 'required';
    else if (tc.type === 'tool') result.tool_choice = { type: 'function', name: tc.name };
  }

  return result;
}

function convertAnthropicBlocksToResponsesParts(blocks: AnyRecord[], role: string): AnyRecord[] {
  const parts: AnyRecord[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({
        type: role === 'user' ? 'input_text' : 'output_text',
        text: block.text,
      });
    } else if (block.type === 'image') {
      const source = block.source as AnyRecord | undefined;
      if (source?.type === 'base64' && source.media_type && source.data) {
        parts.push({
          type: 'input_image',
          image_url: `data:${source.media_type};base64,${source.data}`,
        });
      } else if (source?.type === 'url' && source.url) {
        parts.push({ type: 'input_image', image_url: source.url });
      }
    }
  }
  return parts;
}

// ─── OpenAI Completions → OpenAI Responses ───────────────────────────────────

function completionsToResponses(body: AnyRecord): AnyRecord {
  const srcMessages = (body.messages as AnyRecord[]) ?? [];
  let instructions: string | undefined;
  const input: AnyRecord[] = [];

  for (const msg of srcMessages) {
    const role = msg.role as string;

    if (role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : contentPartsToText(msg.content as AnyRecord[]);
      instructions = instructions ? `${instructions}\n${text}` : text;
      continue;
    }

    if (role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      });
      continue;
    }

    const toolCalls = msg.tool_calls as AnyRecord[] | undefined;
    const content = msg.content;

    // 先处理文本/图片内容
    if (content != null) {
      if (typeof content === 'string') {
        input.push({ role, content });
      } else if (Array.isArray(content)) {
        const parts = convertCompletionsPartsToResponsesParts(content as AnyRecord[], role);
        if (parts.length > 0) {
          input.push({ role, content: parts });
        }
      }
    }

    // tool_calls → function_call 输入项
    if (toolCalls) {
      for (const tc of toolCalls) {
        const fn = tc.function as AnyRecord | undefined;
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: fn?.name,
          arguments: fn?.arguments ?? '{}',
        });
      }
    }
  }

  const result: AnyRecord = { model: body.model, input, stream: body.stream };
  if (instructions) result.instructions = instructions;
  if (body.max_tokens != null) result.max_output_tokens = body.max_tokens;
  if (body.temperature != null) result.temperature = body.temperature;
  if (body.top_p != null) result.top_p = body.top_p;
  if (body.tools) {
    result.tools = (body.tools as AnyRecord[]).map((t) => {
      const fn = (t.function ?? t) as AnyRecord;
      return { type: 'function', name: fn.name, description: fn.description, parameters: fn.parameters };
    });
  }
  if (body.tool_choice != null) result.tool_choice = body.tool_choice;

  return result;
}

function convertCompletionsPartsToResponsesParts(parts: AnyRecord[], role: string): AnyRecord[] {
  const result: AnyRecord[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      result.push({ type: role === 'user' ? 'input_text' : 'output_text', text: part.text });
    } else if (part.type === 'image_url') {
      const imageUrl = part.image_url as AnyRecord;
      result.push({ type: 'input_image', image_url: imageUrl?.url ?? '' });
    }
  }
  return result;
}

// ─── OpenAI Responses → Anthropic ────────────────────────────────────────────

function responsesToAnthropic(body: AnyRecord): AnyRecord {
  let system: string | undefined;
  const messages: AnyRecord[] = [];

  // instructions → system
  if (body.instructions) {
    system = body.instructions as string;
  }

  const input = body.input;

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input as AnyRecord[]) {
      const type = item.type as string | undefined;

      if (type === 'function_call') {
        // → assistant tool_use
        messages.push({
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: item.call_id ?? item.id ?? `toolu_${Math.random().toString(36).slice(2, 10)}`,
              name: item.name,
              input: safeJsonParse(item.arguments as string),
            },
          ],
        });
      } else if (type === 'function_call_output') {
        // → user tool_result
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: item.call_id,
              content: item.output ?? '',
            },
          ],
        });
      } else {
        // message item
        const role = (item.role as string) ?? 'user';
        if (role === 'system') {
          const text =
            typeof item.content === 'string'
              ? item.content
              : Array.isArray(item.content)
                ? (item.content as AnyRecord[])
                    .filter((p) => p.type === 'input_text' || p.type === 'text')
                    .map((p) => p.text as string)
                    .join('\n')
                : '';
          system = system ? `${system}\n${text}` : text;
        } else {
          const blocks = convertResponsesContentToAnthropicBlocks(item.content, role);
          messages.push({ role, content: blocks });
        }
      }
    }
  }

  const result: AnyRecord = { model: body.model, messages };
  if (system) result.system = system;
  if (body.max_output_tokens != null) result.max_tokens = body.max_output_tokens;
  else result.max_tokens = 4096;
  if (body.temperature != null) result.temperature = body.temperature;
  if (body.top_p != null) result.top_p = body.top_p;
  if (body.stream != null) result.stream = body.stream;
  if (body.tools) {
    result.tools = (body.tools as AnyRecord[]).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters ?? {},
    }));
  }
  if (body.tool_choice) {
    if (body.tool_choice === 'auto') result.tool_choice = { type: 'auto' };
    else if (body.tool_choice === 'required') result.tool_choice = { type: 'any' };
    else if (typeof body.tool_choice === 'object') {
      const tc = body.tool_choice as AnyRecord;
      if (tc.name) result.tool_choice = { type: 'tool', name: tc.name };
    }
  }

  return result;
}

function convertResponsesContentToAnthropicBlocks(
  content: unknown,
  role: string,
): AnyRecord[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: 'text', text: '' }];
  }

  const blocks: AnyRecord[] = [];
  for (const part of content as AnyRecord[]) {
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      blocks.push({ type: 'text', text: part.text ?? '' });
    } else if (part.type === 'input_image') {
      const url = (part.image_url ?? '') as string;
      if (typeof url === 'string' && url.startsWith('data:')) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: match[1], data: match[2] },
          });
        }
      } else {
        blocks.push({ type: 'image', source: { type: 'url', url } });
      }
    }
  }

  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }];
}

// ─── OpenAI Responses → OpenAI Completions ───────────────────────────────────

function responsesToCompletions(body: AnyRecord): AnyRecord {
  const messages: AnyRecord[] = [];

  // instructions → system message
  if (body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }

  const input = body.input;

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input as AnyRecord[]) {
      const type = item.type as string | undefined;

      if (type === 'function_call') {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: item.call_id ?? item.id,
              type: 'function',
              function: { name: item.name, arguments: item.arguments ?? '{}' },
            },
          ],
        });
      } else if (type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
        });
      } else {
        // message item
        const role = (item.role as string) ?? 'user';
        const content = item.content;

        if (typeof content === 'string') {
          messages.push({ role, content });
        } else if (Array.isArray(content)) {
          const parts = convertResponsesPartsToCompletionsParts(content as AnyRecord[]);
          messages.push({ role, content: simplifyCompletionsParts(parts) });
        } else {
          messages.push({ role, content: '' });
        }
      }
    }
  }

  const result: AnyRecord = { model: body.model, messages, stream: body.stream };
  if (body.max_output_tokens != null) result.max_tokens = body.max_output_tokens;
  if (body.temperature != null) result.temperature = body.temperature;
  if (body.top_p != null) result.top_p = body.top_p;
  if (body.tools) {
    result.tools = (body.tools as AnyRecord[]).map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (body.tool_choice != null) result.tool_choice = body.tool_choice;
  if (body.stream === true) {
    result.stream_options = { include_usage: true };
  }

  return result;
}

function convertResponsesPartsToCompletionsParts(parts: AnyRecord[]): AnyRecord[] {
  const result: AnyRecord[] = [];
  for (const part of parts) {
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      result.push({ type: 'text', text: part.text ?? '' });
    } else if (part.type === 'input_image') {
      result.push({ type: 'image_url', image_url: { url: part.image_url ?? '' } });
    }
  }
  return result;
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function safeJsonParse(str: string | undefined | null): unknown {
  if (!str) return {};
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}
