/**
 * docs/usage.md のコード例をそのまま実行して固定する。
 * ページの記述と食い違ったら、直すのは先にページのほうかを確かめること。
 */
import { describe, expect, it } from 'vitest';
import { EffectfulYamlError, evaluateYaml } from '../src/index.js';

describe('docs/usage.md の例', () => {
  it('最小の例', async () => {
    await expect(
      evaluateYaml(
        `
server:
  host: {$param: db_host}
  port: {$param: db_port, $default: 5432}
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
- $log: reading secret
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

  it('$fail は EffectfulYamlError で reject される', async () => {
    const p = evaluateYaml('{$fail: boom}');
    await expect(p).rejects.toBeInstanceOf(EffectfulYamlError);
    await expect(p).rejects.toThrow('failure: boom');
  });
});
