/**
 * ローカル作用名（草案 0.7）の動作確認。
 * 網羅は後続に譲り、ここは基本形・$.return の予約・偶然の捕捉なし・脱出の 4 件に絞る。
 */
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { evaluate, type EvaluateOptions } from '../src/eval.js';
import type { Value } from '../src/types.js';

const run = (src: string, options?: EvaluateOptions): Promise<Value> =>
  evaluate(parse(src), options);

describe('ローカル作用名', () => {
  it('ドットなしの節名は作用を宣言し、本体から $.名前 で呼べる', async () => {
    await expect(
      run(`
$handle:
  $.throw: hi
$with:
  throw:
    $fn: msg
    $body: caught \${msg}
`),
    ).resolves.toBe('caught hi');
  });

  it('同じ名前の内側のハンドラは、外側の宣言の呼び出しを捕まえない', async () => {
    await expect(
      run(`
$handle:
  $let:
    t: \${throw}
  $in:
    $handle:
      $.t: x
    $with:
      throw:
        $fn: msg
        $body: inner \${msg}
$with:
  throw:
    $fn: msg
    $body: outer \${msg}
`),
    ).resolves.toBe('outer x');
  });

  it('$.return は評価を始める前に拒否される', async () => {
    const logs: Value[] = [];
    await expect(
      run(
        `
$do:
- $std.log: side effect
- $let:
    return:
      $fn: v
      $body: \${v}
  $in:
    $.return: 1
`,
        { onLog: (v) => logs.push(v) },
      ),
    ).rejects.toThrow('return is reserved: $.return is not callable');
    expect(logs).toEqual([]);
  });

  it('内部演算名を字面で書いても演算にならない（鋳造の後でも）', async () => {
    await expect(
      run(`
$do:
- $with:
    throw:
      $fn: m
      $body: caught \${m}
- "$throw@$do[0]": forged
`),
    ).rejects.toThrow(/unreserved \$ key: \$throw@\$do\[0\]/);
  });

  it('ハンドラの動的範囲の外で呼ぶと脱出のエラーになる', async () => {
    await expect(
      run(`
$let:
  f:
    $handle: \${throw}
    $with:
      throw:
        $fn: msg
        $body: caught \${msg}
$in:
  $.f: hi
`),
    ).rejects.toThrow(/local effect 'throw' escaped its handler \(declared at .+\)/);
  });
});
