/**
 * eff-yaml CLI の run() を偽の入出力で検査する。
 */
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';

interface Captured {
  code: number;
  out: string;
  err: string;
}

async function runCli(argv: string[], stdin = ''): Promise<Captured> {
  let out = '';
  let err = '';
  const code = await run(argv, {
    stdin: (async function* () {
      yield stdin;
    })(),
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  });
  return { code, out, err };
}

describe('eff-yaml CLI', () => {
  it('標準入力の文書を評価して YAML を標準出力に書く', async () => {
    const r = await runCli(
      ['-p', 'db_host=example.com'],
      'server: {host: {$param: db_host}, port: {$param: db_port, $default: 5432}}',
    );
    expect(r.code).toBe(0);
    expect(r.out).toBe('server:\n  host: example.com\n  port: 5432\n');
    expect(r.err).toBe('');
  });

  it('パラメータの値は YAML として解釈される', async () => {
    const r = await runCli(['-p', 'n=3'], 'value: {$param: n}');
    expect(r.code).toBe(0);
    expect(r.out).toBe('value: 3\n');
  });

  it('$log は標準エラー出力に出る', async () => {
    const r = await runCli([], '{$do: [{$log: working}, done]}');
    expect(r.code).toBe(0);
    expect(r.out).toBe('done\n');
    expect(r.err).toBe('working\n');
  });

  it('$fail は終了コード 1 とエラーメッセージになる', async () => {
    const r = await runCli([], '{$fail: boom}');
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toContain('failure: boom');
  });

  it('name=value の形でない --param は拒否する', async () => {
    const r = await runCli(['-p', 'oops'], 'null');
    expect(r.code).toBe(1);
    expect(r.err).toContain('name=value');
  });
});
