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
  $dns.lookup: cache
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

describe('EvaluateOptions.functions', () => {
  it('ホストの関数は同期でも非同期でもよい', async () => {
    await expect(
      evaluateYaml('{a: {$str.upper: hello}, b: {$svc.double: 2}}', {
        functions: {
          'str.upper': (s) => String(s).toUpperCase(),
          'svc.double': async (n) => Number(n) * 2,
        },
      }),
    ).resolves.toEqual({ a: 'HELLO', b: 4 });
  });

  it('関数は作用ではないので $handler の節で横取りできない', async () => {
    await expect(
      evaluateYaml('{$handler: {svc.f: {$fn: x, $body: {$resume: intercepted}}}, $in: {$svc.f: 1}}', {
        functions: { 'svc.f': () => 'from host' },
      }),
    ).rejects.toThrow("$handler clause 'svc.f' must name an operation, got: <function>");
  });

  it('同じ名前を ops と functions の両方に与えるとエラー', async () => {
    await expect(
      evaluateYaml('null', { ops: { 'a.b': () => 1 }, functions: { 'a.b': () => 2 } }),
    ).rejects.toThrow('host name registered both as an operation and as a function: a.b');
  });

  it('名前は束縛とキーの形（2 区画以上）でなければならない', async () => {
    await expect(evaluateYaml('null', { functions: { f: () => 1 } })).rejects.toThrow(
      'host function name must be a dotted path of names (binding.key): f',
    );
  });

  it('std 名前空間には登録できない', async () => {
    await expect(evaluateYaml('null', { functions: { 'std.foo': () => 1 } })).rejects.toThrow(
      'host cannot register a function in the std namespace: $std.foo',
    );
  });

  it('vault.read と vault.write は一つの束縛 vault にまとまる', async () => {
    const functions = {
      'vault.read': (k: unknown) => `read:${String(k)}`,
      'vault.write': (k: unknown) => `write:${String(k)}`,
    };
    await expect(
      evaluateYaml('{r: {$vault.read: k}, w: {$vault.write: k}}', { functions }),
    ).resolves.toEqual({ r: 'read:k', w: 'write:k' });
    // 束縛は一つなので、隠せば両方とも届かなくなる。
    await expect(
      evaluateYaml('{$let: {vault: {read: 1}}, $in: {$vault.read: k}}', { functions }),
    ).rejects.toThrow('$vault.read is not a function: 1');
  });
});
