import { describe, expect, test } from 'bun:test';
import {
  createTokenUsageStreamCollector,
  enrichLogEventTokenUsage,
  extractTokenUsageFromJson,
  extractTokenUsageFromResponseText,
  extractTokenUsageFromSseText,
} from '../../src/token-usage';

describe('token usage extractor', () => {
  test('应提取 OpenAI/OpenAI-compatible usage 与 cached_tokens', () => {
    const usage = extractTokenUsageFromJson(
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: {
            cached_tokens: 40,
            audio_tokens: 2,
          },
          completion_tokens_details: {
            reasoning_tokens: 5,
            accepted_prediction_tokens: 3,
            rejected_prediction_tokens: 1,
          },
        },
      },
      { source: 'response_body', providerHint: 'openai gpt-4.1' }
    );

    expect(usage?.providerStyle).toBe('openai');
    expect(usage?.inputTokens).toBe(100);
    expect(usage?.outputTokens).toBe(20);
    expect(usage?.totalTokens).toBe(120);
    expect(usage?.cacheHitInputTokens).toBe(40);
    expect(usage?.cacheHitRate).toBe(40);
    expect(usage?.reasoningTokens).toBe(5);
    expect(usage?.acceptedPredictionTokens).toBe(3);
    expect(usage?.rejectedPredictionTokens).toBe(1);
  });

  test('应合并 Anthropic stream 中分散的 message.usage 与 usage', () => {
    const streamText = [
      'event: message_start',
      'data: {"message":{"usage":{"input_tokens":10,"cache_read_input_tokens":4,"cache_creation_input_tokens":6}}}',
      '',
      'event: message_delta',
      'data: {"usage":{"output_tokens":3}}',
      '',
    ].join('\n');

    const usage = extractTokenUsageFromSseText(streamText, 'stream_file', 'anthropic claude');

    expect(usage?.providerStyle).toBe('anthropic');
    expect(usage?.inputTokens).toBe(10);
    expect(usage?.outputTokens).toBe(3);
    expect(usage?.totalTokens).toBe(23);
    expect(usage?.cacheReadInputTokens).toBe(4);
    expect(usage?.cacheCreationInputTokens).toBe(6);
    expect(usage?.cacheHitRateDenominatorTokens).toBe(20);
    expect(usage?.cacheHitRate).toBe(20);
  });

  test('流式 collector 应处理跨 chunk 的 SSE usage', () => {
    const collector = createTokenUsageStreamCollector('openai');
    collector.addChunk(
      new TextEncoder().encode(
        'data: {"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details"'
      )
    );
    collector.addChunk(new TextEncoder().encode(':{"cached_tokens":5}}}\n\n'));

    const usage = collector.getUsage();

    expect(usage?.inputTokens).toBe(10);
    expect(usage?.outputTokens).toBe(2);
    expect(usage?.cacheHitInputTokens).toBe(5);
    expect(usage?.cacheHitRate).toBe(50);
  });

  test('应提取 Gemini 与 DeepSeek 特有缓存字段', () => {
    const gemini = extractTokenUsageFromJson(
      {
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 8,
          totalTokenCount: 108,
          cachedContentTokenCount: 75,
          thoughtsTokenCount: 4,
          toolUsePromptTokenCount: 2,
        },
      },
      { source: 'response_body', providerHint: 'gemini' }
    );

    expect(gemini?.providerStyle).toBe('gemini');
    expect(gemini?.cacheHitRate).toBe(75);
    expect(gemini?.reasoningTokens).toBe(4);
    expect(gemini?.toolUsePromptTokens).toBe(2);

    const deepseek = extractTokenUsageFromResponseText(
      JSON.stringify({
        usage: {
          prompt_tokens: 80,
          completion_tokens: 10,
          prompt_cache_hit_tokens: 60,
          prompt_cache_miss_tokens: 20,
        },
      }),
      'response_body',
      'deepseek'
    );

    expect(deepseek?.providerStyle).toBe('deepseek');
    expect(deepseek?.cacheHitInputTokens).toBe(60);
    expect(deepseek?.cacheMissInputTokens).toBe(20);
    expect(deepseek?.cacheHitRate).toBe(75);
  });

  test('enrichLogEventTokenUsage 应从 response_body 回填 token_usage', () => {
    const event = enrichLogEventTokenUsage({
      provider: 'openai',
      route_type: 'openai-completions',
      response_body: JSON.stringify({
        usage: {
          input_tokens: 11,
          output_tokens: 7,
        },
      }),
    });

    expect(event.token_usage?.inputTokens).toBe(11);
    expect(event.token_usage?.outputTokens).toBe(7);
    expect(event.token_usage?.totalTokens).toBe(18);
  });
});
