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

function normalizeResponsesInputItem(item: unknown): NormalizedChatMessage | null {
  const input = ensureObject(item);
  if (!input) return null;

  const role = normalizeRole(input.role, 'user');

  if (typeof input.content === 'string') {
    return {
      role,
      source: 'request',
      blocks: [{ type: 'text', text: input.content }],
    };
  }

  const blocks: NormalizedContentBlock[] = [];
  for (const partRaw of asArray(input.content)) {
    const part = ensureObject(partRaw);
    if (!part) {
      blocks.push({ type: 'unknown', raw: partRaw, label: 'responses.input' });
      continue;
    }

    const type = asString(part.type);
    if (type === 'input_text' || type === 'text') {
      blocks.push({ type: 'text', text: asString(part.text) ?? '' });
      continue;
    }

    if (type === 'input_image' || type === 'image_url') {
      const imageUrl = ensureObject(part.image_url);
      blocks.push({
        type: 'image',
        url: asString(imageUrl?.url) ?? asString(part.image_url) ?? undefined,
        detail: asString(imageUrl?.detail) ?? undefined,
      });
      continue;
    }

    if (type === 'input_tool_result') {
      blocks.push({
        type: 'tool_result',
        toolUseId: asString(part.call_id) ?? undefined,
        content: part.output,
        isError: part.is_error === true,
      });
      continue;
    }

    blocks.push({ type: 'unknown', raw: partRaw, label: 'responses.input' });
  }

  return {
    role,
    source: 'request',
    blocks: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }],
  };
}

function parseOpenAIResponsesRequest(requestBody: unknown, warnings: string[]): NormalizedChatMessage[] {
  const body = ensureObject(requestBody);
  if (!body) {
    warnings.push('OpenAI responses request body is missing or invalid.');
    return [];
  }

  const input = body.input;
  if (typeof input === 'string') {
    return [
      {
        role: 'user',
        source: 'request',
        blocks: [{ type: 'text', text: input }],
      },
    ];
  }

  const messages: NormalizedChatMessage[] = [];
  for (const item of asArray(input)) {
    const normalized = normalizeResponsesInputItem(item);
    if (normalized) messages.push(normalized);
  }

  return messages;
}

function parseResponseOutputItems(output: unknown[], source: 'response' | 'stream'): NormalizedChatMessage[] {
  const blocks: NormalizedContentBlock[] = [];

  for (const rawItem of output) {
    const item = ensureObject(rawItem);
    if (!item) {
      blocks.push({ type: 'unknown', raw: rawItem, label: 'responses.output' });
      continue;
    }

    const type = asString(item.type);
    if (type === 'message') {
      for (const contentRaw of asArray(item.content)) {
        const content = ensureObject(contentRaw);
        if (!content) {
          blocks.push({ type: 'unknown', raw: contentRaw, label: 'responses.message.content' });
          continue;
        }

        const contentType = asString(content.type);
        if (contentType === 'output_text' || contentType === 'text') {
          blocks.push({ type: 'text', text: asString(content.text) ?? '' });
        } else if (contentType === 'output_image' || contentType === 'image_url') {
          const imageUrl = ensureObject(content.image_url);
          blocks.push({
            type: 'image',
            url: asString(imageUrl?.url) ?? asString(content.image_url) ?? undefined,
            detail: asString(imageUrl?.detail) ?? undefined,
          });
        } else {
          blocks.push({ type: 'unknown', raw: contentRaw, label: 'responses.message.content' });
        }
      }
      continue;
    }

    if (type === 'function_call' || type === 'tool_call') {
      const rawArgs = asString(item.arguments) ?? asString(item.input) ?? '';
      const parsedArgs = rawArgs ? safeJsonParse(rawArgs) : { value: undefined, error: null };
      blocks.push({
        type: 'tool_use',
        id: asString(item.call_id) ?? asString(item.id) ?? undefined,
        name: asString(item.name) ?? undefined,
        input: parsedArgs.value ?? undefined,
        rawInput: rawArgs || undefined,
        partial: rawArgs ? parsedArgs.value == null : false,
      });
      continue;
    }

    if (type === 'function_call_output' || type === 'tool_result') {
      blocks.push({
        type: 'tool_result',
        toolUseId: asString(item.call_id) ?? undefined,
        content: item.output,
        isError: item.is_error === true,
      });
      continue;
    }

    blocks.push({ type: 'unknown', raw: rawItem, label: 'responses.output' });
  }

  if (blocks.length === 0) return [];

  return [
    {
      role: 'assistant',
      source,
      blocks,
    },
  ];
}

function parseOpenAIResponsesResponse(responseBody: string | null, warnings: string[]): NormalizedChatMessage[] {
  if (!responseBody) {
    warnings.push('OpenAI responses non-stream response body is empty.');
    return [];
  }

  const parsed = safeJsonParse(responseBody);
  if (!parsed.value || !isRecord(parsed.value)) {
    warnings.push(`OpenAI responses JSON parse failed: ${parsed.error ?? 'invalid json'}`);
    return [
      {
        role: 'assistant',
        source: 'response',
        blocks: [{ type: 'text', text: responseBody }],
        meta: { parseWarnings: ['fallback-to-raw-text'] },
      },
    ];
  }

  const response = parsed.value;

  const messages = parseResponseOutputItems(asArray(response.output), 'response');
  if (messages.length === 0) return [];

  return messages.map((message) => ({
    ...message,
    meta: {
      model: asString(response.model) ?? undefined,
      stopReason: asString(response.status) ?? null,
      usage: response.usage,
    },
  }));
}

interface ResponsesStreamAccumulator {
  text: string;
  functionCalls: Map<string, { name?: string; argumentsRaw: string; parsed?: unknown; partial: boolean }>;
  rawItems: unknown[];
  model?: string;
  status?: string;
}

function parseOpenAIResponsesStream(streamContent: string | null, warnings: string[]): {
  messages: NormalizedChatMessage[];
  streamEventCount: number;
  partial: boolean;
} {
  if (!streamContent) {
    warnings.push('OpenAI responses stream content is empty.');
    return { messages: [], streamEventCount: 0, partial: false };
  }

  const sse = parseSseFrames(streamContent);
  warnings.push(...sse.warnings.map((item) => `OpenAI responses stream: ${item}`));

  const state: ResponsesStreamAccumulator = {
    text: '',
    functionCalls: new Map(),
    rawItems: [],
  };

  for (const frame of sse.frames) {
    const payload = frame.data.trim();
    if (!payload || payload === '[DONE]') continue;

    const parsed = safeJsonParse(payload);
    if (!parsed.value || !isRecord(parsed.value)) {
      warnings.push(`OpenAI responses frame #${frame.frameNo} JSON parse failed.`);
      continue;
    }

    const eventType = asString(parsed.value.type) ?? frame.event ?? '';

    if (eventType === 'response.output_text.delta') {
      state.text += asString(parsed.value.delta) ?? '';
      continue;
    }

    if (eventType === 'response.output_item.added') {
      const item = parsed.value.item;
      state.rawItems.push(item);
      continue;
    }

    if (eventType === 'response.function_call_arguments.delta') {
      const callId = asString(parsed.value.call_id) ?? 'unknown';
      const call = state.functionCalls.get(callId) ?? {
        argumentsRaw: '',
        partial: false,
      };
      call.name = asString(parsed.value.name) ?? call.name;
      call.argumentsRaw += asString(parsed.value.delta) ?? '';
      state.functionCalls.set(callId, call);
      continue;
    }

    if (eventType === 'response.completed') {
      state.status = asString(parsed.value.status) ?? state.status;
      state.model = asString(parsed.value.model) ?? state.model;
      continue;
    }

    if (eventType) {
      // 兼容未知事件，记录但不终止
      warnings.push(`OpenAI responses stream event not handled: ${eventType}`);
    }
  }

  const blocks: NormalizedContentBlock[] = [];

  if (state.text) {
    blocks.push({ type: 'text', text: state.text });
  }

  for (const [callId, call] of state.functionCalls.entries()) {
    if (call.argumentsRaw) {
      const parsedArgs = safeJsonParse(call.argumentsRaw);
      if (parsedArgs.value != null) {
        call.parsed = parsedArgs.value;
        call.partial = false;
      } else {
        call.partial = true;
        warnings.push(`OpenAI responses function_call arguments parse failed (${callId}).`);
      }
    }

    blocks.push({
      type: 'tool_use',
      id: callId,
      name: call.name,
      input: call.parsed,
      rawInput: call.argumentsRaw || undefined,
      partial: call.partial,
    });
  }

  if (state.rawItems.length > 0) {
    const itemBlocks = parseResponseOutputItems(state.rawItems, 'stream')[0]?.blocks ?? [];
    blocks.push(...itemBlocks);
  }

  if (blocks.length === 0) {
    return { messages: [], streamEventCount: sse.frames.length, partial: sse.partial };
  }

  const partial = sse.partial || blocks.some((block) => block.type === 'tool_use' && block.partial);

  return {
    messages: [
      {
        role: 'assistant',
        source: 'stream',
        blocks,
        meta: {
          model: state.model,
          stopReason: state.status ?? null,
          partial,
        },
      },
    ],
    streamEventCount: sse.frames.length,
    partial,
  };
}

export function parseOpenAIResponsesChatHistory(detail: LogEventDetail): RouteParseResult {
  const warnings: string[] = [];

  const inputMessages = parseOpenAIResponsesRequest(detail.request.requestBody, warnings);

  let outputMessages: NormalizedChatMessage[] = [];
  let streamEventCount = 0;
  let partial = false;

  if (detail.upstream.isStream) {
    const stream = parseOpenAIResponsesStream(detail.upstream.streamContent, warnings);
    outputMessages = stream.messages;
    streamEventCount = stream.streamEventCount;
    partial = stream.partial;
  } else {
    outputMessages = parseOpenAIResponsesResponse(detail.response.responseBody, warnings);
  }

  return {
    inputMessages,
    outputMessages,
    warnings,
    streamEventCount,
    partial,
  };
}
