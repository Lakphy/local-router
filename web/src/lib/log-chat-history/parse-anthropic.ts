import type { LogEventDetail } from '../api';
import type { NormalizedChatMessage, NormalizedContentBlock, RouteParseResult } from './types';
import { parseSseFrames } from './parse-sse';
import {
  asArray,
  asString,
  ensureObject,
  isRecord,
  normalizeRole,
  safeJsonParse,
} from './utils';

function normalizeAnthropicContentBlock(block: unknown): NormalizedContentBlock {
  if (!isRecord(block)) {
    return { type: 'unknown', raw: block, label: 'anthropic.content' };
  }

  const type = asString(block.type);
  if (type === 'text') {
    return { type: 'text', text: asString(block.text) ?? '' };
  }

  if (type === 'thinking') {
    return {
      type: 'thinking',
      thinking: asString(block.thinking) ?? '',
      signature: asString(block.signature) ?? undefined,
    };
  }

  if (type === 'tool_use') {
    return {
      type: 'tool_use',
      id: asString(block.id) ?? undefined,
      name: asString(block.name) ?? undefined,
      input: block.input,
    };
  }

  if (type === 'tool_result') {
    return {
      type: 'tool_result',
      toolUseId: asString(block.tool_use_id) ?? undefined,
      content: block.content,
      isError: block.is_error === true,
    };
  }

  if (type === 'image') {
    const source = ensureObject(block.source);
    return {
      type: 'image',
      mimeType: asString(source?.media_type) ?? undefined,
      data: asString(source?.data) ?? undefined,
      detail: asString(source?.type) ?? undefined,
    };
  }

  return { type: 'unknown', raw: block, label: 'anthropic.content' };
}

function normalizeAnthropicMessageContent(content: unknown): NormalizedContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  const blocks = asArray(content).map(normalizeAnthropicContentBlock);
  return blocks.length > 0 ? blocks : [{ type: 'unknown', raw: content, label: 'anthropic.content' }];
}

function parseAnthropicRequest(requestBody: unknown, warnings: string[]): NormalizedChatMessage[] {
  const body = ensureObject(requestBody);
  if (!body) {
    warnings.push('Anthropic request body is missing or invalid.');
    return [];
  }

  const messages: NormalizedChatMessage[] = [];

  const systemRaw = body.system;
  if (typeof systemRaw === 'string') {
    messages.push({
      role: 'system',
      source: 'request',
      blocks: [{ type: 'text', text: systemRaw }],
    });
  } else if (Array.isArray(systemRaw)) {
    const systemText = systemRaw
      .map((item) => {
        if (typeof item === 'string') return item;
        const record = ensureObject(item);
        if (!record) return '';
        return asString(record.text) ?? '';
      })
      .filter(Boolean)
      .join('\n');

    if (systemText) {
      messages.push({
        role: 'system',
        source: 'request',
        blocks: [{ type: 'text', text: systemText }],
      });
    }
  }

  for (const rawMessage of asArray(body.messages)) {
    const message = ensureObject(rawMessage);
    if (!message) continue;

    const role = normalizeRole(message.role, 'user');
    const blocks = normalizeAnthropicMessageContent(message.content);
    messages.push({
      role,
      source: 'request',
      blocks,
    });
  }

  return messages;
}

function parseAnthropicResponse(responseBody: string | null, warnings: string[]): NormalizedChatMessage[] {
  if (!responseBody) {
    warnings.push('Anthropic non-stream response body is empty.');
    return [];
  }

  const parsed = safeJsonParse(responseBody);
  if (!parsed.value || !isRecord(parsed.value)) {
    warnings.push(`Anthropic response JSON parse failed: ${parsed.error ?? 'invalid json'}`);
    return [
      {
        role: 'assistant',
        source: 'response',
        blocks: [{ type: 'text', text: responseBody }],
        meta: { parseWarnings: ['fallback-to-raw-text'] },
      },
    ];
  }

  const content = normalizeAnthropicMessageContent(parsed.value.content);
  return [
    {
      role: 'assistant',
      source: 'response',
      blocks: content,
      meta: {
        model: asString(parsed.value.model) ?? undefined,
        stopReason: asString(parsed.value.stop_reason),
        usage: parsed.value.usage,
      },
    },
  ];
}

type StreamBlockAccumulator =
  | {
      kind: 'text';
      text: string;
    }
  | {
      kind: 'thinking';
      thinking: string;
      signature?: string;
    }
  | {
      kind: 'tool_use';
      id?: string;
      name?: string;
      inputRaw: string;
      partial: boolean;
      input?: unknown;
    }
  | {
      kind: 'tool_result';
      toolUseId?: string;
      content?: unknown;
      isError?: boolean;
    }
  | {
      kind: 'image';
      mimeType?: string;
      data?: string;
      detail?: string;
    }
  | {
      kind: 'unknown';
      raw: unknown;
    };

function accumulatorToBlock(acc: StreamBlockAccumulator): NormalizedContentBlock {
  if (acc.kind === 'text') return { type: 'text', text: acc.text };
  if (acc.kind === 'thinking') {
    return {
      type: 'thinking',
      thinking: acc.thinking,
      signature: acc.signature,
    };
  }
  if (acc.kind === 'tool_use') {
    return {
      type: 'tool_use',
      id: acc.id,
      name: acc.name,
      input: acc.input,
      rawInput: acc.inputRaw || undefined,
      partial: acc.partial,
    };
  }
  if (acc.kind === 'tool_result') {
    return {
      type: 'tool_result',
      toolUseId: acc.toolUseId,
      content: acc.content,
      isError: acc.isError,
    };
  }
  if (acc.kind === 'image') {
    return {
      type: 'image',
      mimeType: acc.mimeType,
      data: acc.data,
      detail: acc.detail,
    };
  }
  return { type: 'unknown', raw: acc.raw, label: 'anthropic.stream' };
}

function createAccumulatorFromContentBlock(raw: unknown): StreamBlockAccumulator {
  const block = ensureObject(raw);
  if (!block) return { kind: 'unknown', raw };

  const type = asString(block.type);
  if (type === 'text') {
    return { kind: 'text', text: asString(block.text) ?? '' };
  }
  if (type === 'thinking') {
    return {
      kind: 'thinking',
      thinking: asString(block.thinking) ?? '',
      signature: asString(block.signature) ?? undefined,
    };
  }
  if (type === 'tool_use') {
    return {
      kind: 'tool_use',
      id: asString(block.id) ?? undefined,
      name: asString(block.name) ?? undefined,
      inputRaw: '',
      partial: false,
      input: block.input,
    };
  }
  if (type === 'tool_result') {
    return {
      kind: 'tool_result',
      toolUseId: asString(block.tool_use_id) ?? undefined,
      content: block.content,
      isError: block.is_error === true,
    };
  }
  if (type === 'image') {
    const source = ensureObject(block.source);
    return {
      kind: 'image',
      mimeType: asString(source?.media_type) ?? undefined,
      data: asString(source?.data) ?? undefined,
      detail: asString(source?.type) ?? undefined,
    };
  }

  return { kind: 'unknown', raw };
}

function parseAnthropicStream(streamContent: string | null, warnings: string[]): {
  messages: NormalizedChatMessage[];
  streamEventCount: number;
  partial: boolean;
} {
  if (!streamContent) {
    warnings.push('Anthropic stream content is empty.');
    return { messages: [], streamEventCount: 0, partial: false };
  }

  const sse = parseSseFrames(streamContent);
  warnings.push(...sse.warnings.map((item) => `Anthropic stream: ${item}`));

  const blocksByIndex = new Map<number, StreamBlockAccumulator>();
  const blockOrder: number[] = [];

  let role: 'assistant' | 'tool' = 'assistant';
  let model: string | undefined;
  let stopReason: string | null | undefined;
  let usage: unknown;

  for (const frame of sse.frames) {
    const data = frame.data.trim();
    if (!data || data === '[DONE]') continue;

    const parsed = safeJsonParse(data);
    if (!parsed.value || !isRecord(parsed.value)) {
      warnings.push(`Anthropic stream frame #${frame.frameNo} JSON parse failed.`);
      continue;
    }

    const type = asString(parsed.value.type);
    if (!type) {
      warnings.push(`Anthropic stream frame #${frame.frameNo} missing type.`);
      continue;
    }

    if (type === 'message_start') {
      const message = ensureObject(parsed.value.message);
      const msgRole = normalizeRole(message?.role, 'assistant');
      role = msgRole === 'tool' ? 'tool' : 'assistant';
      model = asString(message?.model) ?? model;
      usage = message?.usage ?? usage;
      continue;
    }

    if (type === 'content_block_start') {
      const index = typeof parsed.value.index === 'number' ? parsed.value.index : blockOrder.length;
      const acc = createAccumulatorFromContentBlock(parsed.value.content_block);
      blocksByIndex.set(index, acc);
      if (!blockOrder.includes(index)) blockOrder.push(index);
      continue;
    }

    if (type === 'content_block_delta') {
      const index = typeof parsed.value.index === 'number' ? parsed.value.index : blockOrder.length;
      const delta = ensureObject(parsed.value.delta);
      if (!delta) {
        warnings.push(`Anthropic stream frame #${frame.frameNo} has invalid delta.`);
        continue;
      }

      let acc = blocksByIndex.get(index);
      if (!acc) {
        acc = { kind: 'unknown', raw: { inferredFromDelta: true, delta } };
        blocksByIndex.set(index, acc);
        blockOrder.push(index);
      }

      const deltaType = asString(delta.type);
      if (!deltaType) {
        warnings.push(`Anthropic stream frame #${frame.frameNo} delta missing type.`);
        continue;
      }

      if (deltaType === 'text_delta') {
        if (acc.kind !== 'text') {
          acc = { kind: 'text', text: '' };
          blocksByIndex.set(index, acc);
        }
        acc.text += asString(delta.text) ?? '';
        continue;
      }

      if (deltaType === 'thinking_delta') {
        if (acc.kind !== 'thinking') {
          acc = { kind: 'thinking', thinking: '' };
          blocksByIndex.set(index, acc);
        }
        acc.thinking += asString(delta.thinking) ?? '';
        continue;
      }

      if (deltaType === 'signature_delta') {
        if (acc.kind !== 'thinking') {
          acc = { kind: 'thinking', thinking: '' };
          blocksByIndex.set(index, acc);
        }
        acc.signature = `${acc.signature ?? ''}${asString(delta.signature) ?? ''}`;
        continue;
      }

      if (deltaType === 'input_json_delta') {
        if (acc.kind !== 'tool_use') {
          acc = {
            kind: 'tool_use',
            id: undefined,
            name: undefined,
            inputRaw: '',
            partial: true,
          };
          blocksByIndex.set(index, acc);
        }
        acc.inputRaw += asString(delta.partial_json) ?? '';
        continue;
      }

      warnings.push(`Anthropic stream delta type not handled: ${deltaType}`);
      blocksByIndex.set(index, { kind: 'unknown', raw: delta });
      continue;
    }

    if (type === 'content_block_stop') {
      const index = typeof parsed.value.index === 'number' ? parsed.value.index : -1;
      const acc = blocksByIndex.get(index);
      if (acc?.kind === 'tool_use' && acc.inputRaw) {
        const parsedInput = safeJsonParse(acc.inputRaw);
        if (parsedInput.value != null) {
          acc.input = parsedInput.value;
          acc.partial = false;
        } else {
          acc.partial = true;
          warnings.push(`Anthropic tool_use JSON parse failed at block ${index}: ${parsedInput.error}`);
        }
      }
      continue;
    }

    if (type === 'message_delta') {
      const delta = ensureObject(parsed.value.delta);
      if (delta) stopReason = asString(delta.stop_reason) ?? stopReason;
      if (parsed.value.usage !== undefined) usage = parsed.value.usage;
      continue;
    }

    if (type === 'message_stop' || type === 'ping') {
      continue;
    }

    warnings.push(`Anthropic stream event not handled: ${type}`);
  }

  const normalizedBlocks = blockOrder
    .sort((a, b) => a - b)
    .map((index) => blocksByIndex.get(index))
    .filter((item): item is StreamBlockAccumulator => item != null)
    .map(accumulatorToBlock);

  if (normalizedBlocks.length === 0) {
    warnings.push('Anthropic stream produced no content blocks.');
    return { messages: [], streamEventCount: sse.frames.length, partial: sse.partial };
  }

  const hasPartialTool = normalizedBlocks.some(
    (block) => block.type === 'tool_use' && block.partial === true
  );

  return {
    messages: [
      {
        role,
        source: 'stream',
        blocks: normalizedBlocks,
        meta: {
          model,
          stopReason,
          usage,
          partial: sse.partial || hasPartialTool,
        },
      },
    ],
    streamEventCount: sse.frames.length,
    partial: sse.partial || hasPartialTool,
  };
}

export function parseAnthropicChatHistory(detail: LogEventDetail): RouteParseResult {
  const warnings: string[] = [];
  const inputMessages = parseAnthropicRequest(detail.request.requestBody, warnings);

  let outputMessages: NormalizedChatMessage[] = [];
  let streamEventCount = 0;
  let partial = false;

  if (detail.upstream.isStream) {
    const stream = parseAnthropicStream(detail.upstream.streamContent, warnings);
    outputMessages = stream.messages;
    streamEventCount = stream.streamEventCount;
    partial = stream.partial;
  } else {
    outputMessages = parseAnthropicResponse(detail.response.responseBody, warnings);
  }

  return {
    inputMessages,
    outputMessages,
    warnings,
    streamEventCount,
    partial,
  };
}
