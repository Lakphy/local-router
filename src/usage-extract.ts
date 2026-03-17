export interface ExtractedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

const EMPTY_USAGE: ExtractedUsage = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
};

function safeInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  return null;
}

function extractOpenAICompletionsUsage(usage: Record<string, unknown>): ExtractedUsage {
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  return {
    inputTokens: safeInt(usage.prompt_tokens),
    outputTokens: safeInt(usage.completion_tokens),
    cacheReadTokens: details ? safeInt(details.cached_tokens) : null,
    cacheCreationTokens: null,
  };
}

function extractAnthropicUsage(usage: Record<string, unknown>): ExtractedUsage {
  return {
    inputTokens: safeInt(usage.input_tokens),
    outputTokens: safeInt(usage.output_tokens),
    cacheReadTokens: safeInt(usage.cache_read_input_tokens),
    cacheCreationTokens: safeInt(usage.cache_creation_input_tokens),
  };
}

function extractOpenAIResponsesUsage(usage: Record<string, unknown>): ExtractedUsage {
  return {
    inputTokens: safeInt(usage.input_tokens),
    outputTokens: safeInt(usage.output_tokens),
    cacheReadTokens: null,
    cacheCreationTokens: null,
  };
}

export function extractUsageFromResponse(routeType: string, responseText: string): ExtractedUsage {
  try {
    const json = JSON.parse(responseText) as Record<string, unknown>;
    const usage = json.usage as Record<string, unknown> | undefined;
    if (!usage || typeof usage !== 'object') return EMPTY_USAGE;

    switch (routeType) {
      case 'openai-completions':
        return extractOpenAICompletionsUsage(usage);
      case 'anthropic-messages':
        return extractAnthropicUsage(usage);
      case 'openai-responses':
        return extractOpenAIResponsesUsage(usage);
      default:
        return EMPTY_USAGE;
    }
  } catch {
    return EMPTY_USAGE;
  }
}

function parseSSEEvents(sseRawText: string): Array<{ event?: string; data: string }> {
  const results: Array<{ event?: string; data: string }> = [];
  let currentEvent: string | undefined;
  let currentData: string[] = [];

  for (const line of sseRawText.split('\n')) {
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      currentData.push(line.slice(5).trim());
    } else if (line.trim() === '' && currentData.length > 0) {
      results.push({ event: currentEvent, data: currentData.join('\n') });
      currentEvent = undefined;
      currentData = [];
    }
  }

  if (currentData.length > 0) {
    results.push({ event: currentEvent, data: currentData.join('\n') });
  }

  return results;
}

function extractOpenAICompletionsStreamUsage(sseRawText: string): ExtractedUsage {
  const events = parseSSEEvents(sseRawText);
  for (let i = events.length - 1; i >= 0; i--) {
    const { data } = events[i];
    if (data === '[DONE]') continue;
    try {
      const json = JSON.parse(data) as Record<string, unknown>;
      const usage = json.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage === 'object') {
        return extractOpenAICompletionsUsage(usage);
      }
    } catch {}
  }
  return EMPTY_USAGE;
}

function extractAnthropicStreamUsage(sseRawText: string): ExtractedUsage {
  const events = parseSSEEvents(sseRawText);
  let result = EMPTY_USAGE;

  for (const { event, data } of events) {
    if (event !== 'message_delta') continue;
    try {
      const json = JSON.parse(data) as Record<string, unknown>;
      const usage = json.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage === 'object') {
        result = {
          inputTokens: result.inputTokens,
          outputTokens: safeInt(usage.output_tokens) ?? result.outputTokens,
          cacheReadTokens: result.cacheReadTokens,
          cacheCreationTokens: result.cacheCreationTokens,
        };
      }
    } catch {}
  }

  // Also check message_start for input token counts
  for (const { event, data } of events) {
    if (event !== 'message_start') continue;
    try {
      const json = JSON.parse(data) as Record<string, unknown>;
      const message = json.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage === 'object') {
        result = {
          inputTokens: safeInt(usage.input_tokens) ?? result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadTokens: safeInt(usage.cache_read_input_tokens) ?? result.cacheReadTokens,
          cacheCreationTokens:
            safeInt(usage.cache_creation_input_tokens) ?? result.cacheCreationTokens,
        };
      }
    } catch {}
  }

  return result;
}

function extractOpenAIResponsesStreamUsage(sseRawText: string): ExtractedUsage {
  const events = parseSSEEvents(sseRawText);
  for (const { event, data } of events) {
    if (event !== 'response.completed') continue;
    try {
      const json = JSON.parse(data) as Record<string, unknown>;
      const response = json.response as Record<string, unknown> | undefined;
      const usage = (response?.usage ?? json.usage) as Record<string, unknown> | undefined;
      if (usage && typeof usage === 'object') {
        return extractOpenAIResponsesUsage(usage);
      }
    } catch {}
  }
  return EMPTY_USAGE;
}

export function extractUsageFromStream(routeType: string, sseRawText: string): ExtractedUsage {
  switch (routeType) {
    case 'openai-completions':
      return extractOpenAICompletionsStreamUsage(sseRawText);
    case 'anthropic-messages':
      return extractAnthropicStreamUsage(sseRawText);
    case 'openai-responses':
      return extractOpenAIResponsesStreamUsage(sseRawText);
    default:
      return EMPTY_USAGE;
  }
}
