/**
 * docs/usage.md のコード例をそのまま実行して固定する。
 * ページの記述と食い違ったら、直すのは先にページのほうかを確かめること。
 */
import { describe, expect, it } from 'vitest';
import { EffectfulYamlError, evaluateYaml, OperationFailure } from '../src/index.js';

describe('docs/usage.md の例', () => {
  it('最小の例', async () => {
    await expect(
      evaluateYaml(
        `
server:
  host: {$std.param: db_host}
  port: {$std.param: db_port, $default: 5432}
`,
        { params: { db_host: 'example.com' } },
      ),
    ).resolves.toEqual({ server: { host: 'example.com', port: 5432 } });
  });

  it('登録演算とログ', async () => {
    const logs: unknown[] = [];
    await expect(
      evaluateYaml(
        `
$do:
- $std.log: reading secret
- password: {$vault.read: secret/db}
`,
        {
          ops: { 'vault.read': async (path) => `secret(${String(path)})` },
          onLog: (v) => logs.push(v),
        },
      ),
    ).resolves.toEqual({ password: 'secret(secret/db)' });
    expect(logs).toEqual(['reading secret']);
  });

  it('登録演算の失敗', async () => {
    const hosts: Record<string, string> = { db: '10.0.0.5' };
    const ops = {
      'dns.lookup': (name: unknown) => {
        const addr = hosts[String(name)];
        if (addr === undefined) throw new OperationFailure(`unknown host: ${String(name)}`);
        return addr;
      },
    };
    await expect(
      evaluateYaml(
        `
db: {$dns.lookup: db}
cache:
  $std.opt: {$dns.lookup: cache}
  $default: localhost
`,
        { ops },
      ),
    ).resolves.toEqual({ db: '10.0.0.5', cache: 'localhost' });
    // 捕捉されなければ failure として reject される。
    await expect(evaluateYaml('{$dns.lookup: cache}', { ops })).rejects.toThrow(
      'failure: unknown host: cache',
    );
  });

  it('素通しの経路をたどった失敗位置', async () => {
    await expect(
      evaluateYaml(
        `
$do:
- $std.log: start
- server:
    hosts: [a, {$std.range: x}]
`,
        { onLog: () => {} },
      ),
    ).rejects.toThrow(expect.objectContaining({ path: 'server.hosts[1]' }));
  });

  it('$std.fail は EffectfulYamlError で reject される', async () => {
    const p = evaluateYaml('{$std.fail: boom}');
    await expect(p).rejects.toBeInstanceOf(EffectfulYamlError);
    await expect(p).rejects.toThrow('failure: boom');
  });
});
