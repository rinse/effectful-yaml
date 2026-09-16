/**
 * ローカル作用の宣言の動作確認。
 * 基本形、偶然の捕捉なし、宣言ごと・評価ごとに新しい演算の値、引数で受けた演算の処理、
 * $.return の予約、偽造名の拒否、脱出、$resume、スコープの不可視、シャドーイング、
 * $do の文に置いた $handler、節名と節の解決先の検査、節の混在、return 束縛の合法性、
 * 閉包の引数、複数宣言を固定する。
 */
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { evaluate, type EvaluateOptions } from '../src/eval.js';
import type { Value } from '../src/types.js';

const run = (src: string, options?: EvaluateOptions): Promise<Value> =>
  evaluate(parse(src), options);

describe('ローカル作用の宣言', () => {
  it('ドットなしの節名は作用を宣言し、本体から $.名前 で呼べる', async () => {
    await expect(
      run(`
$handler:
  throw:
    $fn: msg
    $body: caught \${msg}
$in:
  $.throw: hi
`),
    ).resolves.toBe('caught hi');
  });

  it('同じ名前の内側のハンドラは、外側の宣言の呼び出しを捕まえない', async () => {
    await expect(
      run(`
$handler:
  throw:
    $fn: msg
    $body: outer \${msg}
$in:
  $let:
    t: \${throw}
  $in:
    $handler:
      throw:
        $fn: msg
        $body: inner \${msg}
    $in:
      $.t: x
`),
    ).resolves.toBe('outer x');
  });

  it('同じ $handler を二度評価すると、それぞれの本体が自分のハンドラに届く', async () => {
    // ハンドラを立てる関数を二度呼ぶ。節が宣言時の引数 tag を捕まえているので、
    // どちらの起動の節が受けたかが値に現れる。
    await expect(
      run(`
$do:
- $let:
    mk:
      $fn: [tag, run]
      $body:
        $handler:
          sig:
            $fn: m
            $body: {$resume: "\${tag} \${m}"}
        $in: {$.run: "\${sig}"}
- $let:
    first: {$.mk: one}
    second: {$.mk: two}
- a: {$.first: {$fn: s, $body: {$.s: x}}}
  b: {$.second: {$fn: s, $body: {$.s: y}}}
`),
    ).resolves.toEqual({ a: 'one x', b: 'two y' });
  });

  it('別々の評価が作った演算は別の値なので、一方の節は他方の呼び出しを捕まえない', async () => {
    // 同じ宣言を二度評価して得た二つの演算の値。p の節を立てて q を呼ぶと、
    // q を処理するハンドラはどこにも無いので境界に達して脱出になる。
    const doc = (call: string) => `
$let:
  mk:
    $fn: _
    $body:
      $handler:
        sig: {$fn: m, $body: {$resume: "caught \${m}"}}
      $in: "\${sig}"
$in:
  $let:
    p: {$.mk: null}
    q: {$.mk: null}
  $in:
    $handler:
      .p: {$fn: m, $body: {$resume: "p handled \${m}"}}
    $in: {${call}: 1}
`;
    await expect(run(doc('$.p'))).resolves.toBe('p handled 1');
    await expect(run(doc('$.q'))).rejects.toThrow(
      "local effect 'sig' escaped its handler (declared at $let.mk.$body)",
    );
  });

  it('引数で受けた演算を .名前 の節で処理できる（宣言した演算の持ち出し）', async () => {
    await expect(
      run(`
$let:
  run:
    $fn: sig
    $body:
      $handler:
        .sig:
          $fn: _
          $body: handled
      $in: {$.sig: null}
  outer:
    $handler:
      signal:
        $fn: _
        $body: unreachable
    $in: \${signal}
$in:
  $.run: \${outer}
`),
    ).resolves.toBe('handled');
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
- $handler:
    throw:
      $fn: m
      $body: caught \${m}
- "$throw@$do.0#0": forged
`),
    ).rejects.toThrow(/unreserved \$ key: \$throw@\$do\.0#0/);
  });

  it('ハンドラの動的範囲の外で呼ぶと脱出のエラーになる（宣言位置は構文パス）', async () => {
    await expect(
      run(`
$let:
  f:
    $handler:
      throw:
        $fn: msg
        $body: caught \${msg}
    $in: \${throw}
$in:
  $.f: hi
`),
    ).rejects.toThrow("local effect 'throw' escaped its handler (declared at $let.f)");
  });

  describe('$resume', () => {
    it('節が $resume で再開すると、本体の残りの計算が続けて評価される', async () => {
      await expect(
        run(`
$handler:
  get:
    $fn: _
    $body: {$resume: 42}
$in:
  $let:
    v: {$.get: null}
  $in: got \${v}
`),
      ).resolves.toBe('got 42');
    });

    it('節の本体で $resume を二度呼び、二つの結果を組み合わせられる', async () => {
      await expect(
        run(`
$handler:
  pick:
    $fn: _
    $body:
      $let:
        r1: {$resume: 10}
        r2: {$resume: 20}
      $in: \${r1 + r2}
$in:
  $let:
    v: {$.pick: null}
  $in: \${v + 1}
`),
      ).resolves.toBe(32); // (10+1) + (20+1)
    });
  });

  describe('スコープの不可視', () => {
    it('ハンドラの外で $.名前 を呼ぶと undefined reference（宣言はハンドラの外から見えない）', async () => {
      await expect(
        run(`
$do:
- $handler:
    throw:
      $fn: m
      $body: \${m}
  $in: ok
- {$.throw: late}
`),
      ).rejects.toThrow('undefined reference: throw');
    });

    it('節の本体の中では宣言した束縛は見えない', async () => {
      await expect(
        run(`
$handler:
  throw:
    $fn: msg
    $body: {$.throw: nested}
$in:
  $.throw: hi
`),
      ).rejects.toThrow('undefined reference: throw');
    });

    it('return 節の中では宣言した束縛は見えない', async () => {
      await expect(
        run(`
$handler:
  throw:
    $fn: m
    $body: caught \${m}
  return:
    $fn: v
    $body:
      $.throw: \${v}
$in: hi
`),
      ).rejects.toThrow('undefined reference: throw');
    });
  });

  it('シャドーイング：入れ子のハンドラが同じ名前を宣言すると、内側の本体の呼び出しは内側の節に届く', async () => {
    await expect(
      run(`
$handler:
  throw:
    $fn: m
    $body: outer \${m}
$in:
  $handler:
    throw:
      $fn: m
      $body: inner \${m}
  $in:
    $.throw: x
`),
    ).resolves.toBe('inner x');
  });

  describe('$do の文に置いた $handler', () => {
    it('束縛は $in を省いた $handler より後の文から見える', async () => {
      await expect(
        run(`
$do:
- $handler:
    throw:
      $fn: m
      $body: caught \${m}
- {$.throw: boom}
`),
      ).resolves.toBe('caught boom');
    });

    it('束縛は $in を省いた $handler より前の文からは見えない', async () => {
      await expect(
        run(`
$do:
- {$.throw: too-early}
- $handler:
    throw:
      $fn: m
      $body: caught \${m}
- never
`),
      ).rejects.toThrow('undefined reference: throw');
    });

    it('節名の構文の誤りは $do の文に置いた $handler でもエラーになる', async () => {
      // $ で始まるキーは節名になりえない（節のマッピングは $ キーを持たない）。
      await expect(
        run(`
$do:
- $handler:
    $finally:
      $fn: m
      $body: x
- 1
`),
      ).rejects.toThrow('unreserved $ key: $finally');
      // パスにも裸の名前にもならないキーは節名の誤りとして名指される。
      await expect(
        run(`
$do:
- $handler:
    a..b:
      $fn: m
      $body: x
- 1
`),
      ).rejects.toThrow(
        "$handler clause name must be a path, a bare local name, or 'return', got: a..b",
      );
    });
  });

  it('節の名前が演算に解決しなければエラーになる', async () => {
    await expect(
      run(`
$handler:
  std.list: {$fn: x, $body: 1}
$in: 1
`),
    ).rejects.toThrow("$handler clause 'std.list' must name an operation, got: <function>");
  });

  it('混在：ドット付きの節とローカル宣言と return 節を同居させても、すべて機能する', async () => {
    await expect(
      run(`
$handler:
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
$in:
  $do:
  - $let:
      a: {$.bump: 1}
  - $let:
      b: {$std.fail: ignored}
  - sum \${a + b}
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

  it('閉包を引数に渡すと節がそれを適用できる（ホストの値とは異なり合法）', async () => {
    await expect(
      run(`
$handler:
  apply:
    $fn: f
    $body: {$.f: 41}
$in:
  $let:
    inc:
      $fn: x
      $body: \${x + 1}
  $in:
    $.apply: \${inc}
`),
    ).resolves.toBe(42);
  });

  it('一つの $handler に複数のローカル宣言を書くと両方呼べる', async () => {
    await expect(
      run(`
$handler:
  log2:
    $fn: n
    $body:
      $resume: \${n * 2}
  throw:
    $fn: n
    $body:
      $resume: \${n + 1}
$in:
  $do:
  - $let:
      a: {$.log2: 10}
  - $let:
      b: {$.throw: 20}
  - \${a + b}
`),
    ).resolves.toBe(41); // a = 10*2, b = 20+1
  });
});
