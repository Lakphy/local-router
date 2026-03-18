/**
 * 响应体格式转换：将上游 provider 的 targetFormat 响应转换回客户端期望的 sourceFormat。
 *
 * 注意：response body 是原始字符串（非流式），需要自行 JSON.parse / JSON.stringify。
 */

import type { ProtocolFormat } from './convert-request';

interface AnyRecord {
  [key: string]: unknown;
}

// ─── 主入口 ───────────────────────────────────────────────────────────────────

/**
 * 转换响应体。
 * @param bodyStr  原始响应文本
 * @param source   客户端期望的格式（ctx.routeType）
 * @param target   上游 provider 实际使用的格式
 */
export function convertResponseBody(
  bodyStr: string,
  source: ProtocolFormat,
  target: ProtocolFormat,
): string {
  if (source === target) return bodyStr;

  let body: AnyRecord;
  try {
    body = JSON.parse(bodyStr) as AnyRecord;
  } catch {
    return bodyStr;
  }

  // 上游发 target 格式，需转换为 source 格式
  const key = `${target}->${source}`;
  let result: AnyRecord;

  switch (key) {
    case 'openai-completions->anthropic-messages':
      result = completionsToAnthropic(body);
      break;
    case 'openai-completions->openai-responses':
      result = completionsToResponses(body);
      break;
    case 'anthropic-messages->openai-completions':
      result = anthropicToCompletions(body);
      break;
    case 'anthropic-messages->openai-responses':
      result = anthropicToResponses(body);
      break;
    case 'openai-responses->anthropic-messages':
      result = responsesToAnthropic(body);
      break;
    case 'openai-responses->openai-completions':
      result = responsesToCompletions(body);
      break;
    default:
      return bodyStr;
  }

  return JSON.stringify(result);
}

// ─── OpenAI Completions Response → Anthropic Messages Response ───────────────

function completionsToAnthropic(body: AnyRecord): AnyRecord {
  const choices = (body.choices as AnyRecord[]) ?? [];
  const firstChoice = choices[0] ?? {};
  const message = (firstChoice.message ?? {}) as AnyRecord;
  const toolCalls = message.tool_calls as AnyRecord[] | undefined;

  const content: AnyRecord[] = [];
  let hasToolUse = false;

  // 文本内容
  if (message.content) {
    content.push({ type: 'text', text: message.content as string });
  }

  // tool_calls → tool_use
  if (toolCalls && toolCalls.length > 0) {
    hasToolUse = true;
    for (const tc of toolCalls) {
      const fn = (tc.function ?? {}) as AnyRecord;
      let input: unknown = {};
      try {
        input = JSON.parse((fn.arguments as string) ?? '{}');
      } catch {
        input = {};
      }
      content.push({
        type: 'tool_use',
        id: tc.id ?? `toolu_${Math.random().toString(36).slice(2, 10)}`,
        name: fn.name,
        input,
      });
    }
  }

  // finish_reason → stop_reason
  const finishReason = firstChoice.finish_reason as string | null;
  let stopReason: string;
  if (hasToolUse) {
    stopReason = 'tool_use';
  } else if (finishReason === 'stop') {
    stopReason = 'end_turn';
  } else if (finishReason === 'length') {
    stopReason = 'max_tokens';
  } else if (finishReason === 'content_filter') {
    stopReason = 'end_turn';
  } else {
    stopReason = 'end_turn';
  }

  const usage = (body.usage ?? {}) as AnyRecord;

  return {
    id: (body.id as string) ?? `msg_${crypto.randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: (usage.prompt_tokens as number) ?? 0,
      output_tokens: (usage.completion_tokens as number) ?? 0,
    },
  };
}

// ─── Anthropic Messages Response → OpenAI Completions Response ───────────────

function anthropicToCompletions(body: AnyRecord): AnyRecord {
  const contentBlocks = (body.content as AnyRecord[]) ?? [];

  let textContent = '';
  const toolCalls: AnyRecord[] = [];

  for (const block of contentBlocks) {
    if (block.type === 'text') {
      textContent += (block.text as string) ?? '';
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  // stop_reason → finish_reason
  const stopReason = body.stop_reason as string | null;
  let finishReason: string;
  if (stopReason === 'end_turn') finishReason = 'stop';
  else if (stopReason === 'max_tokens') finishReason = 'length';
  else if (stopReason === 'tool_use') finishReason = 'tool_calls';
  else if (stopReason === 'stop_sequence') finishReason = 'stop';
  else finishReason = 'stop';

  const message: AnyRecord = {
    role: 'assistant',
    content: textContent || null,
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  const usage = (body.usage ?? {}) as AnyRecord;

  return {
    id: (body.id as string) ?? `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: (usage.input_tokens as number) ?? 0,
      completion_tokens: (usage.output_tokens as number) ?? 0,
      total_tokens:
        ((usage.input_tokens as number) ?? 0) + ((usage.output_tokens as number) ?? 0),
    },
  };
}

// ─── OpenAI Responses Response → Anthropic Messages Response ─────────────────

function responsesToAnthropic(body: AnyRecord): AnyRecord {
  const output = (body.output as AnyRecord[]) ?? [];
  const content: AnyRecord[] = [];
  let hasToolUse = false;

  for (const item of output) {
    if (item.type === 'message' && item.content) {
      for (const part of item.content as AnyRecord[]) {
        if (part.type === 'output_text' && part.text != null) {
          content.push({ type: 'text', text: part.text });
        }
      }
    } else if (item.type === 'function_call') {
      hasToolUse = true;
      let input: unknown = {};
      try {
        input = JSON.parse((item.arguments as string) ?? '{}');
      } catch {
        input = {};
      }
      content.push({
        type: 'tool_use',
        id: (item.call_id as string) ?? (item.id as string) ?? `toolu_${crypto.randomUUID()}`,
        name: item.name ?? 'unknown',
        input,
      });
    }
  }

  let stopReason: string;
  if (hasToolUse) {
    stopReason = 'tool_use';
  } else if (body.status === 'completed') {
    stopReason = 'end_turn';
  } else if (body.status === 'incomplete') {
    stopReason = 'max_tokens';
  } else {
    stopReason = 'end_turn';
  }

  const usage = (body.usage ?? {}) as AnyRecord;

  return {
    id: (body.id as string) ?? `msg_${crypto.randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: (usage.input_tokens as number) ?? 0,
      output_tokens: (usage.output_tokens as number) ?? 0,
    },
  };
}

// ─── Anthropic Messages Response → OpenAI Responses Response ─────────────────

function anthropicToResponses(body: AnyRecord): AnyRecord {
  const contentBlocks = (body.content as AnyRecord[]) ?? [];
  const output: AnyRecord[] = [];

  const msgContent: AnyRecord[] = [];
  const functionCalls: AnyRecord[] = [];

  for (const block of contentBlocks) {
    if (block.type === 'text') {
      msgContent.push({ type: 'output_text', text: block.text, annotations: [] });
    } else if (block.type === 'tool_use') {
      functionCalls.push({
        type: 'function_call',
        id: block.id,
        call_id: block.id,
        name: block.name,
        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
        status: 'completed',
      });
    }
  }

  if (msgContent.length > 0) {
    output.push({
      type: 'message',
      id: `msg_${crypto.randomUUID()}`,
      role: 'assistant',
      content: msgContent,
      status: 'completed',
    });
  }

  output.push(...functionCalls);

  const status =
    body.stop_reason === 'max_tokens'
      ? 'incomplete'
      : 'completed';

  const usage = (body.usage ?? {}) as AnyRecord;

  return {
    id: (body.id as string) ?? `resp_${crypto.randomUUID()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: body.model,
    output,
    status,
    usage: {
      input_tokens: (usage.input_tokens as number) ?? 0,
      output_tokens: (usage.output_tokens as number) ?? 0,
      total_tokens:
        ((usage.input_tokens as number) ?? 0) + ((usage.output_tokens as number) ?? 0),
    },
  };
}

// ─── OpenAI Completions Response → OpenAI Responses Response ─────────────────

function completionsToResponses(body: AnyRecord): AnyRecord {
  const choices = (body.choices as AnyRecord[]) ?? [];
  const firstChoice = choices[0] ?? {};
  const message = (firstChoice.message ?? {}) as AnyRecord;
  const toolCalls = message.tool_calls as AnyRecord[] | undefined;

  const output: AnyRecord[] = [];

  const msgContent: AnyRecord[] = [];
  if (message.content) {
    msgContent.push({
      type: 'output_text',
      text: message.content as string,
      annotations: [],
    });
  }

  if (msgContent.length > 0) {
    output.push({
      type: 'message',
      id: `msg_${crypto.randomUUID()}`,
      role: 'assistant',
      content: msgContent,
      status: 'completed',
    });
  }

  if (toolCalls) {
    for (const tc of toolCalls) {
      const fn = (tc.function ?? {}) as AnyRecord;
      output.push({
        type: 'function_call',
        id: tc.id,
        call_id: tc.id,
        name: fn.name,
        arguments: fn.arguments ?? '{}',
        status: 'completed',
      });
    }
  }

  const finishReason = firstChoice.finish_reason as string | null;
  const status = finishReason === 'length' ? 'incomplete' : 'completed';

  const usage = (body.usage ?? {}) as AnyRecord;

  return {
    id: (body.id as string) ?? `resp_${crypto.randomUUID()}`,
    object: 'response',
    created_at: (body.created as number) ?? Math.floor(Date.now() / 1000),
    model: body.model,
    output,
    status,
    usage: {
      input_tokens: (usage.prompt_tokens as number) ?? 0,
      output_tokens: (usage.completion_tokens as number) ?? 0,
      total_tokens: (usage.total_tokens as number) ?? 0,
    },
  };
}

// ─── OpenAI Responses Response → OpenAI Completions Response ─────────────────

function responsesToCompletions(body: AnyRecord): AnyRecord {
  const output = (body.output as AnyRecord[]) ?? [];
  let textContent = '';
  const toolCalls: AnyRecord[] = [];

  for (const item of output) {
    if (item.type === 'message' && item.content) {
      for (const part of item.content as AnyRecord[]) {
        if (part.type === 'output_text') {
          textContent += (part.text as string) ?? '';
        }
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: (item.call_id as string) ?? (item.id as string),
        type: 'function',
        function: {
          name: item.name,
          arguments: (item.arguments as string) ?? '{}',
        },
      });
    }
  }

  const message: AnyRecord = {
    role: 'assistant',
    content: textContent || null,
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  const status = body.status as string;
  let finishReason: string;
  if (toolCalls.length > 0) finishReason = 'tool_calls';
  else if (status === 'incomplete') finishReason = 'length';
  else finishReason = 'stop';

  const usage = (body.usage ?? {}) as AnyRecord;

  return {
    id: (body.id as string) ?? `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: (body.created_at as number) ?? Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: (usage.input_tokens as number) ?? 0,
      completion_tokens: (usage.output_tokens as number) ?? 0,
      total_tokens: (usage.total_tokens as number) ?? 0,
    },
  };
}
