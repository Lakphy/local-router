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

function normalizeOpenAIRequestContent(content: unknown): NormalizedContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  if (!Array.isArray(content)) {
    if (content == null) return [];
    return [{ type: 'unknown', raw: content, label: 'openai.request.content' }];
  }

  const blocks: NormalizedContentBlock[] = [];

  for (const item of content) {
    const part = ensureObject(item);
    if (!part) {
      blocks.push({ type: 'unknown', raw: item, label: 'openai.request.part' });
      continue;
    }

    const partType = asString(part.type);
    if (partType === 'text' || partType === 'input_text') {
      blocks.push({ type: 'text', text: asString(part.text) ?? '' });
      continue;
    }

    if (partType === 'image_url' || partType === 'input_image') {
      const imageUrl = ensureObject(part.image_url);
      blocks.push({
        type: 'image',
        url: asString(imageUrl?.url) ?? asString(part.image_url) ?? undefined,
        detail: asString(imageUrl?.detail) ?? undefined,
      });
      continue;
    }

    blocks.push({ type: 'unknown', raw: item, label: 'openai.request.part' });
  }

  return blocks;
}

function parseOpenAICompletionsRequest(requestBody: unknown, warnings: string[]): NormalizedChatMessage[] {
  const body = ensureObject(requestBody);
  if (!body) {
    warnings.push('OpenAI completions request body is missing or invalid.');
    return [];
  }

  const messages: NormalizedChatMessage[] = [];

  for (const rawMessage of asArray(body.messages)) {
    const message = ensureObject(rawMessage);
    if (!message) continue;

    const role = normalizeRole(message.role, 'user');
    const blocks = normalizeOpenAIRequestContent(message.content);

    if (Array.isArray(message.tool_calls)) {
      for (const rawCall of message.tool_calls) {
        const call = ensureObject(rawCall);
        if (!call) {
          blocks.push({ type: 'unknown', raw: rawCall, label: 'openai.request.tool_call' });
          continue;
        }
        const functionData = ensureObject(call.function);
        let input: unknown;
        const rawArguments = asString(functionData?.arguments);
        if (rawArguments) {
          const parsed = safeJsonParse(rawArguments);
          input = parsed.value ?? rawArguments;
        }
        blocks.push({
          type: 'tool_use',
          id: asString(call.id) ?? undefined,
          name: asString(functionData?.name) ?? undefined,
          input,
          rawInput: rawArguments ?? undefined,
          partial: false,
        });
      }
    }

    messages.push({
      role,
      source: 'request',
      blocks: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }],
    });
  }

  return messages;
}

function normalizeAssistantMessage(message: Record<string, unknown>): NormalizedContentBlock[] {
  const blocks: NormalizedContentBlock[] = [];

  const content = message.content;
  if (typeof content === 'string') {
    blocks.push({ type: 'text', text: content });
  } else if (Array.isArray(content)) {
    blocks.push(...normalizeOpenAIRequestContent(content));
  } else if (content != null) {
    blocks.push({ type: 'unknown', raw: content, label: 'openai.response.content' });
  }

  const toolCalls = asArray(message.tool_calls);
  for (const rawToolCall of toolCalls) {
    const toolCall = ensureObject(rawToolCall);
    if (!toolCall) {
      blocks.push({ type: 'unknown', raw: rawToolCall, label: 'openai.response.tool_call' });
      continue;
    }

    const fn = ensureObject(toolCall.function);
    const rawArgs = asString(fn?.arguments);
    let input: unknown;
    let partial = false;

    if (rawArgs) {
      const parsedArgs = safeJsonParse(rawArgs);
      input = parsedArgs.value ?? rawArgs;
      partial = parsedArgs.value == null;
    }

    blocks.push({
      type: 'tool_use',
      id: asString(toolCall.id) ?? undefined,
      name: asString(fn?.name) ?? undefined,
      input,
      rawInput: rawArgs ?? undefined,
      partial,
    });
  }

  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: '' });
  }

  return blocks;
}

function parseOpenAICompletionsResponse(responseBody: string | null, warnings: string[]): NormalizedChatMessage[] {
  if (!responseBody) {
    warnings.push('OpenAI completions non-stream response body is empty.');
    return [];
  }

  const parsed = safeJsonParse(responseBody);
  if (!parsed.value || !isRecord(parsed.value)) {
    warnings.push(`OpenAI completions response JSON parse failed: ${parsed.error ?? 'invalid json'}`);
    return [
      {
        role: 'assistant',
        source: 'response',
        blocks: [{ type: 'text', text: responseBody }],
        meta: { parseWarnings: ['fallback-to-raw-text'] },
      },
    ];
  }

  const choices = asArray(parsed.value.choices);
  const firstChoice = ensureObject(choices[0]);
  const assistant = ensureObject(firstChoice?.message);
  if (!assistant) {
    warnings.push('OpenAI completions response missing choices[0].message.');
    return [];
  }

  return [
    {
      role: normalizeRole(assistant.role, 'assistant'),
      source: 'response',
      blocks: normalizeAssistantMessage(assistant),
      meta: {
        model: asString(parsed.value.model) ?? undefined,
        stopReason: asString(firstChoice?.finish_reason),
        usage: parsed.value.usage,
      },
    },
  ];
}

interface ToolCallAccumulator {
  id?: string;
  name?: string;
  argumentsRaw: string;
  parsedArguments?: unknown;
  partial: boolean;
}

function parseOpenAICompletionsStream(streamContent: string | null, warnings: string[]): {
  messages: NormalizedChatMessage[];
  streamEventCount: number;
  partial: boolean;
} {
  if (!streamContent) {
    warnings.push('OpenAI completions stream content is empty.');
    return { messages: [], streamEventCount: 0, partial: false };
  }

  const sse = parseSseFrames(streamContent);
  warnings.push(...sse.warnings.map((item) => `OpenAI completions stream: ${item}`));

  let text = '';
  let role: 'assistant' | 'tool' = 'assistant';
  let model: string | undefined;
  let finishReason: string | null | undefined;

  const toolCalls = new Map<number, ToolCallAccumulator>();

  for (const frame of sse.frames) {
    const rawData = frame.data.trim();
    if (!rawData) continue;
    if (rawData === '[DONE]') continue;

    const parsed = safeJsonParse(rawData);
    if (!parsed.value || !isRecord(parsed.value)) {
      warnings.push(`OpenAI completions frame #${frame.frameNo} JSON parse failed.`);
      continue;
    }

    model = asString(parsed.value.model) ?? model;

    for (const rawChoice of asArray(parsed.value.choices)) {
      const choice = ensureObject(rawChoice);
      if (!choice) continue;

      finishReason = asString(choice.finish_reason) ?? finishReason;
      const delta = ensureObject(choice.delta);
      if (!delta) continue;

      const deltaRole = asString(delta.role);
      if (deltaRole === 'assistant' || deltaRole === 'tool') {
        role = deltaRole;
      }

      const deltaContent = asString(delta.content);
      if (deltaContent) {
        text += deltaContent;
      }

      for (const rawToolCall of asArray(delta.tool_calls)) {
        const toolCall = ensureObject(rawToolCall);
        if (!toolCall) continue;

        const index = typeof toolCall.index === 'number' ? toolCall.index : toolCalls.size;
        const existing = toolCalls.get(index) ?? {
          argumentsRaw: '',
          partial: false,
        };

        existing.id = asString(toolCall.id) ?? existing.id;
        const fn = ensureObject(toolCall.function);
        existing.name = asString(fn?.name) ?? existing.name;
        existing.argumentsRaw += asString(fn?.arguments) ?? '';

        toolCalls.set(index, existing);
      }
    }
  }

  const blocks: NormalizedContentBlock[] = [];
  if (text) blocks.push({ type: 'text', text });

  const toolEntries = Array.from(toolCalls.entries()).sort((a, b) => a[0] - b[0]);
  for (const [, tool] of toolEntries) {
    if (tool.argumentsRaw) {
      const parsedArgs = safeJsonParse(tool.argumentsRaw);
      if (parsedArgs.value != null) {
        tool.parsedArguments = parsedArgs.value;
        tool.partial = false;
      } else {
        tool.parsedArguments = undefined;
        tool.partial = true;
        warnings.push(`OpenAI completions tool call arguments parse failed: ${parsedArgs.error}`);
      }
    }

    blocks.push({
      type: 'tool_use',
      id: tool.id,
      name: tool.name,
      input: tool.parsedArguments,
      rawInput: tool.argumentsRaw || undefined,
      partial: tool.partial,
    });
  }

  if (blocks.length === 0) {
    warnings.push('OpenAI completions stream produced no assistant content.');
    return { messages: [], streamEventCount: sse.frames.length, partial: sse.partial };
  }

  const hasPartialTool = blocks.some((block) => block.type === 'tool_use' && block.partial === true);

  return {
    messages: [
      {
        role,
        source: 'stream',
        blocks,
        meta: {
          model,
          stopReason: finishReason,
          partial: sse.partial || hasPartialTool,
        },
      },
    ],
    streamEventCount: sse.frames.length,
    partial: sse.partial || hasPartialTool,
  };
}

export function parseOpenAICompletionsChatHistory(detail: LogEventDetail): RouteParseResult {
  const warnings: string[] = [];

  const inputMessages = parseOpenAICompletionsRequest(detail.request.requestBody, warnings);

  let outputMessages: NormalizedChatMessage[] = [];
  let streamEventCount = 0;
  let partial = false;

  if (detail.upstream.isStream) {
    const stream = parseOpenAICompletionsStream(detail.upstream.streamContent, warnings);
    outputMessages = stream.messages;
    streamEventCount = stream.streamEventCount;
    partial = stream.partial;
  } else {
    outputMessages = parseOpenAICompletionsResponse(detail.response.responseBody, warnings);
  }

  return {
    inputMessages,
    outputMessages,
    warnings,
    streamEventCount,
    partial,
  };
}
