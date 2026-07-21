import type { MdErrorBlock, MdSection } from './render-md';

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

/** Terminal display width, including CJK and emoji wide characters. */
export function displayWidth(value: string): number {
  let width = 0;
  for (const char of value.replace(ANSI_PATTERN, '')) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (/\p{Mark}/u.test(char) || codePoint === 0xfe0f || codePoint === 0x200d) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function padCell(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return value.replace(/\r?\n/g, ' ');
  return String(value);
}

/** Render a Linux-style, whitespace-aligned table without Markdown borders. */
export function renderHumanTable(headers: string[], rows: Array<Array<unknown>>): string {
  if (rows.length === 0) return '无记录';
  const normalizedHeaders = headers.map((header) => stripInlineMarkdown(header).toUpperCase());
  const normalizedRows = rows.map((row) =>
    normalizedHeaders.map((_, index) => stripInlineMarkdown(formatScalar(row[index])))
  );
  const widths = normalizedHeaders.map((header, index) =>
    Math.max(
      header.length === 0 ? 0 : displayWidth(header),
      ...normalizedRows.map((row) => displayWidth(row[index] ?? ''))
    )
  );
  const renderRow = (row: string[]) =>
    row
      .map((cell, index) => padCell(cell, widths[index] ?? 0))
      .join('  ')
      .trimEnd();
  return [renderRow(normalizedHeaders), ...normalizedRows.map(renderRow)].join('\n');
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim();
  const body = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const withoutEnd = body.endsWith('|') ? body.slice(0, -1) : body;
  const cells: string[] = [];
  let cell = '';
  let escaped = false;
  for (const char of withoutEnd) {
    if (escaped) {
      cell += char;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  if (escaped) cell += '\\';
  cells.push(cell.trim());
  return cells;
}

function isTableSeparator(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

/** Remove the small, controlled subset of inline Markdown emitted by the CLI. */
export function stripInlineMarkdown(value: string): string {
  return value
    .replace(/<!--.*?-->/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,，。:：])/g, '$1$2')
    .replace(/\\([|`*_\\])/g, '$1')
    .trim();
}

function pushBlank(lines: string[]): void {
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
}

/** Convert CLI-generated Markdown fragments (tables, fences, lists) to terminal text. */
export function renderHumanFragment(markdown: string): string {
  const source = markdown.split(/\r?\n/);
  const output: string[] = [];

  for (let index = 0; index < source.length; index++) {
    const line = source[index] ?? '';
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      const code: string[] = [];
      index += 1;
      while (index < source.length && !(source[index] ?? '').trim().startsWith('```')) {
        code.push(source[index] ?? '');
        index += 1;
      }
      for (const codeLine of code) output.push(`  ${codeLine}`.trimEnd());
      continue;
    }

    if (
      trimmed.startsWith('|') &&
      index + 1 < source.length &&
      isTableSeparator(source[index + 1] ?? '')
    ) {
      const headers = splitMarkdownTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < source.length && (source[index] ?? '').trim().startsWith('|')) {
        rows.push(splitMarkdownTableRow(source[index] ?? ''));
        index += 1;
      }
      index -= 1;
      output.push(renderHumanTable(headers, rows));
      continue;
    }

    if (trimmed === '') {
      pushBlank(output);
      continue;
    }

    const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      output.push(`${stripInlineMarkdown(heading[1] ?? '')}:`);
      continue;
    }

    const label = trimmed.match(/^\*\*([^*]+)\*\*\s*$/);
    if (label) {
      output.push(`${stripInlineMarkdown(label[1] ?? '')}:`);
      continue;
    }

    if (trimmed.startsWith('>')) {
      output.push(`  ${stripInlineMarkdown(trimmed.replace(/^>\s?/, ''))}`.trimEnd());
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      output.push(`  - ${stripInlineMarkdown(bullet[1] ?? '')}`);
      continue;
    }

    const numbered = trimmed.match(/^(\d+\.)\s+(.+)$/);
    if (numbered) {
      output.push(`${numbered[1]} ${stripInlineMarkdown(numbered[2] ?? '')}`);
      continue;
    }

    const explanation = trimmed.match(/^_([^_]+)_$/);
    if (explanation) {
      output.push(`   ${stripInlineMarkdown(explanation[1] ?? '')}`);
      continue;
    }

    output.push(stripInlineMarkdown(line));
  }

  return output
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isFlatRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => item === null || typeof item !== 'object')
  );
}

function indent(value: string, spaces = 2): string {
  const prefix = ' '.repeat(spaces);
  return value
    .split('\n')
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join('\n');
}

/** Human-readable fallback for commands without a dedicated presentation. */
export function renderHumanValue(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') {
    return formatScalar(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '无记录';
    if (value.every(isFlatRecord)) {
      const headers = [...new Set(value.flatMap((item) => Object.keys(item)))];
      return renderHumanTable(
        headers,
        value.map((item) =>
          headers.map((header) => {
            const cell = item[header];
            return typeof cell === 'object' && cell !== null ? JSON.stringify(cell) : cell;
          })
        )
      );
    }
    return value
      .map((item) => {
        const rendered = renderHumanValue(item);
        return rendered.includes('\n') ? `-\n${indent(rendered)}` : `- ${rendered}`;
      })
      .join('\n');
  }

  const record = value as Record<string, unknown>;
  const simple = Object.entries(record).filter(
    ([, item]) => item === null || typeof item !== 'object'
  );
  const complex = Object.entries(record).filter(
    ([, item]) => item !== null && typeof item === 'object'
  );
  const parts: string[] = [];
  if (simple.length > 0) {
    parts.push(renderHumanTable(['字段', '值'], simple));
  }
  for (const [key, item] of complex) {
    if (parts.length > 0) parts.push('');
    parts.push(`${key}:`);
    parts.push(indent(renderHumanValue(item)));
  }
  return parts.join('\n');
}

function renderHumanErrorBlock(error: MdErrorBlock): string {
  const lines = [`错误: ${stripInlineMarkdown(error.message)}`, `  错误码: ${error.code}`];
  if (error.hint) lines.push(`  提示: ${stripInlineMarkdown(error.hint)}`);
  if (error.doc) lines.push(`  文档: ${stripInlineMarkdown(error.doc)}`);
  if (error.details !== undefined) {
    lines.push('', '详情:', indent(renderHumanValue(error.details)));
  }
  return lines.join('\n');
}

/** Render one command result in the default, terminal-friendly format. */
export function renderHuman(section: MdSection): string {
  const parts: string[] = [stripInlineMarkdown(section.heading)];
  if (section.meta && section.meta.length > 0) {
    parts.push(section.meta.map((line) => `  ${stripInlineMarkdown(line)}`).join('\n'));
  }
  if (section.data) parts.push(renderHumanFragment(section.data));
  if (section.errorDetails) parts.push(renderHumanErrorBlock(section.errorDetails));
  if (section.extra) {
    for (const extra of section.extra) {
      parts.push(`${stripInlineMarkdown(extra.heading)}:\n${renderHumanFragment(extra.body)}`);
    }
  }
  if (section.hints && section.hints.length > 0) {
    parts.push(
      ['提示:', ...section.hints.map((hint) => `  ${stripInlineMarkdown(hint)}`)].join('\n')
    );
  }
  return `${parts
    .filter((part) => part.trim().length > 0)
    .join('\n\n')
    .trimEnd()}\n`;
}

export interface HumanError {
  command: string;
  code: string;
  message: string;
  hint?: string;
  doc?: string;
  details?: unknown;
  detailsOmitted?: boolean;
  exitCode: number;
}

/** Errors follow normal CLI conventions: concise text on stderr, never Markdown. */
export function renderHumanError(error: HumanError): string {
  const lines = [
    `错误: ${stripInlineMarkdown(error.message)}`,
    `  命令: ${error.command}`,
    `  错误码: ${error.code} (exit ${error.exitCode})`,
  ];
  if (error.hint) lines.push(`  提示: ${stripInlineMarkdown(error.hint)}`);
  if (error.doc) lines.push(`  文档: ${stripInlineMarkdown(error.doc)}`);
  if (error.details !== undefined) {
    lines.push('', '详情:', indent(renderHumanValue(error.details)));
  } else if (error.detailsOmitted) {
    lines.push('  详情: 使用 --verbose 查看');
  }
  return `${lines.join('\n')}\n`;
}

function streamValue(value: unknown): string {
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  const rendered = formatScalar(value);
  return /\s/.test(rendered) ? JSON.stringify(rendered) : rendered;
}

/** Compact one-event-per-line presentation for interactive streaming commands. */
export function renderHumanStreamEvent(
  eventType: string,
  payload: Record<string, unknown>
): string {
  const fields = Object.entries(payload).map(([key, value]) => `${key}=${streamValue(value)}`);
  return `${eventType}${fields.length > 0 ? `  ${fields.join('  ')}` : ''}\n`;
}
