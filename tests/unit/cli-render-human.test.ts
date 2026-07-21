import { describe, expect, test } from 'bun:test';
import { DEFAULT_FLAGS } from '../../src/cli/global-flags';
import { createOutputContext, emitDiagnostic } from '../../src/cli/output';
import {
  displayWidth,
  renderHuman,
  renderHumanError,
  renderHumanFragment,
  renderHumanStreamEvent,
  renderHumanTable,
  renderHumanValue,
} from '../../src/cli/render-human';

describe('CLI human renderer', () => {
  test('renders whitespace-aligned tables with CJK-aware widths', () => {
    const output = renderHumanTable(
      ['命令', '状态'],
      [
        ['status', '运行中'],
        ['配置', 'ok'],
      ]
    );
    const [header, first, second] = output.split('\n');

    expect(header).toBe('命令    状态');
    expect(first).toBe('status  运行中');
    expect(second).toBe('配置    ok');
    expect(displayWidth('配置')).toBe(4);
  });

  test('converts every Markdown construct emitted by command templates', () => {
    const output = renderHumanFragment(
      [
        '**Top providers**',
        '',
        '| name | status | note |',
        '| --- | --- | --- |',
        '| `本地` | **ok** | a\\|b |',
        '',
        '```json',
        '{"ok": true}',
        '```',
        '',
        '- 详情: `local-router status`',
        '1. `local-router init`',
        '   _生成配置_',
      ].join('\n')
    );

    expect(output).toContain('Top providers:');
    expect(output).toContain('NAME  STATUS  NOTE');
    expect(output).toContain('本地  ok      a|b');
    expect(output).toContain('  {"ok": true}');
    expect(output).toContain('  - 详情: local-router status');
    expect(output).toContain('1. local-router init\n   生成配置');
    expect(output).not.toMatch(/```|\*\*|`/);
    expect(output).not.toContain('| ---');
  });

  test('renders sections, hints, and generic nested values without Markdown', () => {
    const section = renderHuman({
      heading: 'status · `running`',
      meta: ['地址 `http://127.0.0.1:4099`'],
      data: '| 字段 | 值 |\n| --- | --- |\n| pid | `42` |',
      hints: ['查看日志: `local-router logs daemon`'],
    });
    expect(section).toBe(
      [
        'status · running',
        '',
        '  地址 http://127.0.0.1:4099',
        '',
        '字段  值',
        'pid   42',
        '',
        '提示:',
        '  查看日志: local-router logs daemon',
        '',
      ].join('\n')
    );

    const fallback = renderHumanValue({ ok: true, items: [{ name: 'a', enabled: true }] });
    expect(fallback).toContain('ok');
    expect(fallback).toContain('items:');
    expect(fallback).toContain('NAME  ENABLED');
    expect(fallback).not.toContain('```');
  });

  test('renders errors for stderr and streams as compact terminal lines', () => {
    const error = renderHumanError({
      command: 'status',
      code: 'NOT_RUNNING',
      message: '服务`未运行`',
      hint: '运行 `local-router start`',
      details: { port: 4099 },
      exitCode: 3,
    });
    expect(error).toContain('错误: 服务未运行');
    expect(error).toContain('错误码: NOT_RUNNING (exit 3)');
    expect(error).toContain('提示: 运行 local-router start');
    expect(error).not.toMatch(/^##|```|`/m);

    expect(renderHumanStreamEvent('event', { id: 'e1', message: 'hello world' })).toBe(
      'event  id=e1  message="hello world"\n'
    );
  });

  test('strips inline Markdown from human diagnostics', () => {
    const originalWrite = process.stderr.write;
    let captured = '';
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      emitDiagnostic(
        createOutputContext({ ...DEFAULT_FLAGS, output: 'human' }),
        '输入 `/exit` 或 **Ctrl+C** 退出'
      );
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(captured).toBe('输入 /exit 或 Ctrl+C 退出\n');
  });
});
