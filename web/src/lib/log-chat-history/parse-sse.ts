export interface ParsedSseFrame {
  event: string | null;
  data: string;
  frameNo: number;
  rawFrame: string;
}

export interface ParsedSseResult {
  frames: ParsedSseFrame[];
  warnings: string[];
  partial: boolean;
}

export function parseSseFrames(content: string): ParsedSseResult {
  const warnings: string[] = [];
  const normalized = content.replace(/\r\n/g, '\n');
  const frames: ParsedSseFrame[] = [];

  let partial = normalized.includes('[TRUNCATED]');

  const rawFrames = normalized.split('\n\n');
  for (let index = 0; index < rawFrames.length; index += 1) {
    const rawFrame = rawFrames[index];
    const trimmed = rawFrame.trim();
    if (!trimmed) continue;

    if (trimmed === '[TRUNCATED]') {
      partial = true;
      continue;
    }

    const lines = rawFrame.split('\n');
    let event: string | null = null;
    const dataLines: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line) continue;

      if (line.startsWith('event:')) {
        event = line.slice(6).trim() || null;
        continue;
      }

      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
        continue;
      }

      if (line === '[TRUNCATED]') {
        partial = true;
        continue;
      }

      // 兼容非标准分帧：整行就是 data 内容。
      dataLines.push(line);
    }

    if (dataLines.length === 0) {
      warnings.push(`SSE frame #${index + 1} has no data.`);
      continue;
    }

    frames.push({
      event,
      data: dataLines.join('\n'),
      frameNo: index + 1,
      rawFrame,
    });
  }

  if (frames.length > 0) {
    const lastData = frames[frames.length - 1]?.data?.trim();
    if (lastData && lastData !== '[DONE]' && !normalized.endsWith('\n\n') && !partial) {
      warnings.push('SSE stream tail may be incomplete.');
      partial = true;
    }
  }

  return { frames, warnings, partial };
}
