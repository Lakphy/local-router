/**
 * `local-router chat` — interactive REPL routing through the running daemon.
 * Stays in OpenAI completions shape; the daemon handles upstream conversion.
 */
import { createInterface } from 'node:readline/promises';
import { CliError } from '../errors';
import { emitDiagnostic } from '../output';
import { checkHealth, cleanupIfStale } from '../process';
import { defineSchemaCommand } from '../registry';
import { readRuntimeState } from '../runtime';

interface ChatFlags {
  entry: string;
  model: string;
  system?: string;
  'no-stream'?: boolean;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

defineSchemaCommand<ChatFlags>({
  name: 'chat',
  summary: '交互式 REPL（默认走 openai-completions，流式）',
  supportsJson: false,
  requiresRunning: true,
  flags: [
    {
      // REPL 仅支持 chat completions 协议；其他入口协议请用 `local-router try`。
      name: 'entry',
      type: 'enum',
      enum: ['openai-completions'],
      default: 'openai-completions',
      description: '入口协议（当前 REPL 仅 openai-completions）',
    },
    { name: 'model', type: 'string', required: true, description: '请求 model（路由匹配键）' },
    { name: 'system', type: 'string', description: 'system prompt' },
    { name: 'no-stream', type: 'boolean', description: '禁用流式（一次返回）' },
  ],
  fn: async ({ values, ctx }) => {
    await cleanupIfStale();
    const state = readRuntimeState();
    if (!state) throw new CliError('SERVICE_NOT_RUNNING', '服务未运行');
    if (!(await checkHealth(state.baseUrl))) {
      throw new CliError('HEALTH_FAILED', `服务健康检查失败: ${state.baseUrl}`);
    }
    if (!process.stdin.isTTY) {
      throw new CliError('INTERACTIVE_REQUIRED', 'chat 需要 TTY', {
        hint: '管道场景请用 `local-router try`',
      });
    }
    const baseUrl = state.baseUrl.replace(/\/+$/, '');
    const url = `${baseUrl}/openai-completions/v1/chat/completions`;
    const messages: ChatMessage[] = [];
    if (values.system) messages.push({ role: 'system', content: values.system });

    emitDiagnostic(
      ctx,
      `chat → ${values.entry}/${values.model} · 输入 \`/exit\` 或 Ctrl+C 退出 · /reset 清空上下文`
    );

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      while (true) {
        const input = (await rl.question('› ')).trim();
        if (!input) continue;
        if (input === '/exit' || input === '/quit') return;
        if (input === '/reset') {
          messages.length = 0;
          if (values.system) messages.push({ role: 'system', content: values.system });
          process.stdout.write('(上下文已清空)\n');
          continue;
        }
        messages.push({ role: 'user', content: input });
        try {
          const reply = await sendOnce(url, values.model, messages, !values['no-stream']);
          if (!reply) throw new Error('上游返回空回复');
          messages.push({ role: 'assistant', content: reply });
        } catch (err) {
          // 回滚 user message，避免下一轮把 [..., user, "" ] 再发给上游
          messages.pop();
          process.stderr.write(`[chat] ${(err as Error).message}\n`);
        }
      }
    } finally {
      rl.close();
    }
  },
});

async function sendOnce(
  url: string,
  model: string,
  messages: ChatMessage[],
  stream: boolean
): Promise<string> {
  if (!stream) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content ?? '';
    process.stdout.write(`${content}\n`);
    return content;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ model, messages, stream: true }),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let acc = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = obj.choices?.[0]?.delta?.content ?? '';
        if (delta) {
          process.stdout.write(delta);
          acc += delta;
        }
      } catch {
        // 忽略非 JSON chunk
      }
    }
  }
  process.stdout.write('\n');
  return acc;
}
