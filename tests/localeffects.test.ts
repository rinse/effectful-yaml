/**
 * ローカル作用名の動作確認。
 * 基本形・偶然の捕捉なし・$.return の予約・偽造名の拒否・脱出に加え、$resume・スコープの
 * 不可視・シャドーイング・$do の $with 文・節の混在・return 束縛の合法性・閉包の引数・
 * 複数宣言まで一通り固定する。
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

  describe('$resume', () => {
    it('節が $resume で再開すると、本体の残りの計算が続けて評価される', async () => {
      await expect(
        run(`
$handle:
  $let:
    v: {$.get: null}
  $in: got \${v}
$with:
  get:
    $fn: _
    $body: {$resume: 42}
`),
      ).resolves.toBe('got 42');
    });

    it('節の本体で $resume を二度呼び、二つの結果を組み合わせられる', async () => {
      await expect(
        run(`
$handle:
  $let:
    v: {$.pick: null}
  $in: \${v + 1}
$with:
  pick:
    $fn: _
    $body:
      $let:
        r1: {$resume: 10}
        r2: {$resume: 20}
      $in: \${r1 + r2}
`),
      ).resolves.toBe(32); // (10+1) + (20+1)
    });
  });

  describe('スコープの不可視', () => {
    it('ハンドラの外で $.名前 を呼ぶと undefined reference（宣言はハンドラの外から見えない）', async () => {
      await expect(
        run(`
$do:
- $handle: ok
  $with:
    throw:
      $fn: m
      $body: \${m}
- {$.throw: late}
`),
      ).rejects.toThrow('undefined reference: throw');
    });

    it('節の本体の中では宣言した束縛は見えない', async () => {
      await expect(
        run(`
$handle:
  $.throw: hi
$with:
  throw:
    $fn: msg
    $body: {$.throw: nested}
`),
      ).rejects.toThrow('undefined reference: throw');
    });

    it('return 節の中では宣言した束縛は見えない', async () => {
      await expect(
        run(`
$handle: hi
$with:
  throw:
    $fn: m
    $body: caught \${m}
  return:
    $fn: v
    $body:
      $.throw: \${v}
`),
      ).rejects.toThrow('undefined reference: throw');
    });
  });

  it('シャドーイング：入れ子のハンドラが同じ名前を宣言すると、内側の本体の呼び出しは内側の節に届く', async () => {
    await expect(
      run(`
$handle:
  $handle:
    $.throw: x
  $with:
    throw:
      $fn: m
      $body: inner \${m}
$with:
  throw:
    $fn: m
    $body: outer \${m}
`),
    ).resolves.toBe('inner x');
  });

  describe('$do の $with 文', () => {
    it('束縛は $with 文より後の文から見える', async () => {
      await expect(
        run(`
$do:
- $with:
    throw:
      $fn: m
      $body: caught \${m}
- {$.throw: boom}
`),
      ).resolves.toBe('caught boom');
    });

    it('束縛は $with 文より前の文からは見えない', async () => {
      await expect(
        run(`
$do:
- {$.throw: too-early}
- $with:
    throw:
      $fn: m
      $body: caught \${m}
- never
`),
      ).rejects.toThrow('undefined reference: throw');
    });

    it('$ で始まる節名は $do の $with 文でもエラーになる', async () => {
      await expect(
        run(`
$do:
- $with:
    $finally:
      $fn: m
      $body: x
- 1
`),
      ).rejects.toThrow(
        /clause name must be an operation name, a bare local name, or 'return'/,
      );
    });
  });

  it('混在：ドット付きの節とローカル宣言と return 節を同居させても、すべて機能する', async () => {
    await expect(
      run(`
$handle:
  $do:
  - $let:
      a: {$.bump: 1}
  - $let:
      b: {$std.fail: ignored}
  - sum \${a + b}
$with:
  std.fail:
    $fn: msg
    $body:
      $resume: 100
  bump:
    $fn: n
    $body:
      $resume: \${n + 1}
  return:
    $fn: v
    $body: got \${v}
`),
    ).resolves.toBe('got sum 102');
  });

  it('$let: {return: ...} の束縛は合法で ${return} が参照できる', async () => {
    await expect(
      run(`
$let:
  return: 5
$in: \${return + 1}
`),
    ).resolves.toBe(6);
  });

  it('$.return.x も評価前に拒否される', async () => {
    const logs: Value[] = [];
    await expect(
      run(
        `
$do:
- $std.log: side effect
- $let:
    return:
      x:
        $fn: v
        $body: \${v}
  $in:
    $.return.x: 1
`,
        { onLog: (v) => logs.push(v) },
      ),
    ).rejects.toThrow('return is reserved: $.return is not callable');
    expect(logs).toEqual([]);
  });

  it('閉包を引数に渡すと節がそれを適用できる（ホスト演算とは異なり合法）', async () => {
    await expect(
      run(`
$handle:
  $let:
    inc:
      $fn: x
      $body: \${x + 1}
  $in:
    $.apply: \${inc}
$with:
  apply:
    $fn: f
    $body: {$.f: 41}
`),
    ).resolves.toBe(42);
  });

  it('一つの $with に複数のローカル宣言を書くと両方呼べる', async () => {
    await expect(
      run(`
$handle:
  $do:
  - $let:
      a: {$.log2: 10}
  - $let:
      b: {$.throw: 20}
  - \${a + b}
$with:
  log2:
    $fn: n
    $body:
      $resume: \${n * 2}
  throw:
    $fn: n
    $body:
      $resume: \${n + 1}
`),
    ).resolves.toBe(41); // a = 10*2, b = 20+1
  });
});
