import type { LogEventDetail } from '../api';
import { parseAnthropicChatHistory } from './parse-anthropic';
import { parseOpenAICompletionsChatHistory } from './parse-openai-completions';
import { parseOpenAIResponsesChatHistory } from './parse-openai-responses';
import type { ParsedChatHistory, RouteParseResult } from './types';

function emptyResultWithWarning(warning: string): RouteParseResult {
  return {
    inputMessages: [],
    outputMessages: [],
    warnings: [warning],
    streamEventCount: 0,
    partial: false,
  };
}

function parseByRouteType(detail: LogEventDetail): RouteParseResult {
  const routeType = detail.summary.routeType;

  if (routeType === 'anthropic-messages') {
    return parseAnthropicChatHistory(detail);
  }

  if (routeType === 'openai-completions') {
    return parseOpenAICompletionsChatHistory(detail);
  }

  if (routeType === 'openai-responses') {
    return parseOpenAIResponsesChatHistory(detail);
  }

  return emptyResultWithWarning(`Route type not supported for chat history parse: ${routeType}`);
}

export function parseChatHistory(detail: LogEventDetail): ParsedChatHistory {
  const routeParsed = parseByRouteType(detail);
  const warnings = [...routeParsed.warnings];

  if (!detail.capture.requestBodyAvailable) {
    warnings.unshift('请求 body 不可用，输入历史可能不完整。');
  }

  if (detail.capture.bodyPolicy === 'off') {
    warnings.unshift('bodyPolicy=off，无法完整还原请求/响应消息体。');
  }

  if (detail.upstream.isStream && !detail.capture.streamCaptured) {
    warnings.push('流式请求未捕获 streamContent，输出消息可能缺失。');
  }

  const messages = [...routeParsed.inputMessages, ...routeParsed.outputMessages];

  return {
    messages,
    warnings,
    stats: {
      inputCount: routeParsed.inputMessages.length,
      outputCount: routeParsed.outputMessages.length,
      streamEventCount: routeParsed.streamEventCount,
      streamPartial: routeParsed.partial,
    },
  };
}
