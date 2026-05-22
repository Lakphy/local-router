export interface MdErrorBlock {
  code: string;
  message: string;
  hint?: string;
  doc?: string;
  details?: unknown;
}

export interface MdSection {
  /** Top-level "## " heading body. */
  heading: string;
  /** Blockquote lines below the heading. */
  meta?: string[];
  /** Pre-rendered Markdown for the "### 数据" section. */
  data?: string;
  /** Bullet hints under "### 提示". */
  hints?: string[];
  /** Optional error block (for failed commands). */
  errorDetails?: MdErrorBlock;
  /** Extra named sections after data, before hints. */
  extra?: Array<{ heading: string; body: string }>;
}

export function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderTable(headers: string[], rows: Array<Array<unknown>>): string {
  if (rows.length === 0) return '_(无记录)_';
  const sep = headers.map(() => '---');
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...rows.map((r) => `| ${r.map((cell) => escapeCell(cell)).join(' | ')} |`),
  ];
  return lines.join('\n');
}

export function renderKv(
  rows: Array<{ key: string; value: string | number | boolean | null | undefined }>
): string {
  return renderTable(
    ['字段', '值'],
    rows.map((r) => [
      r.key,
      r.value === undefined || r.value === null || r.value === '' ? '–' : `\`${r.value}\``,
    ])
  );
}

export function renderCodeBlock(content: string, lang = ''): string {
  return `\`\`\`${lang}\n${content}\n\`\`\``;
}

export function renderMd(sec: MdSection): string {
  const parts: string[] = [];
  parts.push(`## ${sec.heading}`);
  parts.push('');
  if (sec.meta && sec.meta.length > 0) {
    parts.push(sec.meta.map((l) => `> ${l}`).join('\n'));
    parts.push('');
  }
  if (sec.data) {
    parts.push('### 数据');
    parts.push('');
    parts.push(sec.data);
    parts.push('');
  }
  if (sec.errorDetails) {
    parts.push('### 错误');
    parts.push('');
    parts.push(`- code: \`${sec.errorDetails.code}\``);
    parts.push(`- message: ${sec.errorDetails.message}`);
    if (sec.errorDetails.hint) parts.push(`- hint: ${sec.errorDetails.hint}`);
    if (sec.errorDetails.doc) parts.push(`- doc: \`${sec.errorDetails.doc}\``);
    parts.push('');
    if (sec.errorDetails.details !== undefined) {
      parts.push('### 详情');
      parts.push('');
      parts.push(renderCodeBlock(JSON.stringify(sec.errorDetails.details, null, 2), 'json'));
      parts.push('');
    }
  }
  if (sec.extra) {
    for (const ex of sec.extra) {
      parts.push(`### ${ex.heading}`);
      parts.push('');
      parts.push(ex.body);
      parts.push('');
    }
  }
  if (sec.hints && sec.hints.length > 0) {
    parts.push('### 提示');
    parts.push('');
    parts.push(sec.hints.map((h) => `- ${h}`).join('\n'));
    parts.push('');
  }
  return `${parts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
