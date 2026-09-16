/**
 * 評価前の検査（未定義参照・関数値の流れ・ホストの実装に渡る引数）。
 * 仕様: docs/grammar/values.md「環境と名前の解決」・docs/grammar/checks.md「関数値の流れと停止性」・docs/grammar/host.md。
 *
 * 未定義参照は、呼び出しの先頭区画と `${...}` の参照名の先頭区画がレキシカルに決まることを固定する。
 * 自己適用の拒否側は、値が構文から隠れる経路（std.collect の with 引数、ハンドラ節の引数、
 * 既定ハンドラの状態）を通る密輸も評価前に捕まることを固定する。
 * 受理側は、公認のイディオム（関数とデータの分岐、リテラル列の $std.each、部分適用、
 * 節が関数を返し $resume の値を適用する形、処理系の関数の入れ子）が拒否されないことを固定する。
 */
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { evaluate, type EvaluateOptions } from '../src/eval.js';
import type { Value } from '../src/types.js';

const run = (src: string, options?: EvaluateOptions): Promise<Value> =>
  evaluate(parse(src), options);

const SELF_APP = /self-application detected/;

describe('未定義参照の拒否', () => {
  it('呼び出しのパスの先頭区画が束縛でなければ評価前に拒否される', async () => {
    await expect(run('{$nope.f: 1}')).rejects.toThrow('undefined reference: nope');
  });

  it('${...} の参照名の先頭区画も同じく拒否される', async () => {
    await expect(run('"\${nope}"')).rejects.toThrow('undefined reference: nope');
    await expect(run('x: "a\${nope.x}b"')).rejects.toThrow('undefined reference: nope');
    await expect(run('{$if: "\${nope > 1}", $then: 1, $else: 2}')).rejects.toThrow(
      'undefined reference: nope',
    );
  });

  it('実行されない位置（$if の選ばれない分岐・$default）でも拒否される', async () => {
    await expect(run('{$if: true, $then: 1, $else: "\${nope}"}')).rejects.toThrow(
      'undefined reference: nope',
    );
    await expect(run('{$std.param: p, $default: "\${nope}"}', { params: { p: 1 } })).rejects.toThrow(
      'undefined reference: nope',
    );
  });

  it('登録されていないホストの演算は束縛が無いので、評価を始める前に拒否される', async () => {
    // 0.13 では `ops` / `functions` が初期環境の束縛になるので、未登録の名前は未定義参照である。
    const logs: Value[] = [];
    await expect(
      run(
        `
$do:
- {$std.log: side effect}
- {$vault.read: secret/db/password}
`,
        { onLog: (v) => logs.push(v) },
      ),
    ).rejects.toThrow('undefined reference: vault');
    expect(logs).toEqual([]); // 評価は始まっていない
  });

  it('std とホストが与えた束縛は初期スコープにあるので通る', async () => {
    await expect(
      run(
        `
$do:
- {$vault.read: k}
- {$svc.f: k}
- "\${std.each}"
- ok
`,
        { ops: { 'vault.read': () => 1 }, functions: { 'svc.f': () => 2 } },
      ),
    ).resolves.toBe('ok');
  });
});

describe('自己適用の拒否', () => {
  it('Ω 項（f f を f に適用）は評価前に拒否され、発散しない', async () => {
    // 評価器はトランポリンなのでスタックは溢れず回り続けてしまう形であり、検査だけが止められる。
    const logs: Value[] = [];
    await expect(
      run(
        `
$do:
- {$std.log: before}
- $let:
    x:
      $fn: f
      $body:
        $.f: \${f}
- $.x: \${x}
`,
        { onLog: (v) => logs.push(v) },
      ),
    ).rejects.toThrow(SELF_APP);
    expect(logs).toEqual([]); // 評価は始まっていない
  });

  it('エラーには $ 式の内側へ降りる構文上の位置が付く', async () => {
    await expect(
      run(`
unfinite:
  $let:
    x:
      $fn: f
      $body:
        $.f: \${f}
  $in:
    $.x: \${x}
`),
    ).rejects.toThrow(/self-application detected: .*unfinite\.\$let\.x/);
  });

  it('$let の別名を経由しても拒否される', async () => {
    await expect(
      run(`
$do:
- $let: {w: {$fn: g, $body: {$.g: '\${g}'}}}
- $let: {v: '\${w}'}
- $.v: \${v}
`),
    ).rejects.toThrow(SELF_APP);
  });

  it('マッピングのフィールドに包んで渡しても拒否される', async () => {
    await expect(
      run(`
$do:
- $let:
    a:
      $fn: p
      $body: {$.p.go: '\${p}'}
- $.a: {go: '\${a}'}
`),
    ).rejects.toThrow(SELF_APP);
  });

  it('二つの関数がマッピング越しに循環しても拒否される', async () => {
    await expect(
      run(`
$do:
- $let:
    a: {$fn: p, $body: {$.p.other: '\${p}'}}
- $let:
    b: {$fn: q, $body: {$.q.other: '\${q}'}}
- $.a: {other: '\${b}'}
`),
    ).rejects.toThrow(SELF_APP);
  });

  it('$if の分岐に紛れても拒否される', async () => {
    await expect(
      run(`
$do:
- $let: {w: {$fn: g, $body: {$.g: '\${g}'}}}
- $let:
    x:
      $if: true
      $then: \${w}
      $else: 0
- $handler: "\${std.list}"
  $in: {$.x: '\${x}'}
`),
    ).rejects.toThrow(SELF_APP);
  });

  it('実行されない分岐の自己適用も拒否される（出現主義）', async () => {
    // 実行すれば 0 で止まる文書だが、作用の推論と同じく出現だけを見る。
    await expect(
      run(`
$do:
- $let:
    f:
      $fn: g
      $body:
        $if: true
        $then: 0
        $else: {$.g: '\${g}'}
- $.f: \${f}
`),
    ).rejects.toThrow(SELF_APP);
  });

  it('$std.collect の with の引数を通る密輸も拒否される（全域の検査）', async () => {
    // 引数の値は構文からは見えないが、流れの検査は全域なので捕まえる。
    await expect(
      run(`
$std.collect:
  in:
  - $fn: c
    $body: {$.c: '\${c}'}
  with:
    $fn: e
    $body:
    - {$.e: '\${e}'}
`),
    ).rejects.toThrow(SELF_APP);
  });

  it('ハンドラの節の引数を通る密輸も拒否される（全域の検査）', async () => {
    await expect(
      run(
        `
$handler:
  my.op:
    $fn: f
    $body: {$.f: '\${f}'}
$in:
  $my.op:
    $fn: w
    $body: {$.w: '\${w}'}
`,
        { ops: { 'my.op': () => null } },
      ),
    ).rejects.toThrow(SELF_APP);
  });

  it('ローカル節を通る密輸も拒否される（節名がローカル名でも全域の検査）', async () => {
    // 上のテストと同じ形を、演算名 my.op の代わりにローカル作用の宣言 run で書いたもの。
    await expect(
      run(`
$handler:
  run:
    $fn: f
    $body: {$.f: '\${f}'}
$in:
  $.run:
    $fn: w
    $body: {$.w: '\${w}'}
`),
    ).rejects.toThrow(SELF_APP);
  });

  it('呼び出しの結果（Cod）を経由する混合の循環も拒否される', async () => {
    // f = λh. (h null)(h)、g = λ_. f。f(g) は g の結果の f が f 自身の適用に届いて発散する。
    await expect(
      run(`
$do:
- $let:
    f:
      $fn: h
      $body:
        $let:
          r: {$.h: null}
        $in: {$.r: '\${h}'}
- $let:
    g: {$fn: _, $body: '\${f}'}
- $.f: \${g}
`),
    ).rejects.toThrow(SELF_APP);
  });

  it('既定ハンドラの状態を通る結び目（Landin の knot）も拒否される', async () => {
    // 関数を状態のセルに置き、読み出して適用する形の一般再帰。パラメータを経由しない。
    await expect(
      run(`
$do:
- $let:
    f:
      $fn: x
      $body:
        $let: {h: {$std.get: c}}
        $in: {$.h: 0}
- $std.set: {c: '\${f}'}
- $.f: 0
`),
    ).rejects.toThrow(SELF_APP);
  });

  it('本体の閉包をとる利用者の関数を、その閉包の本体の中で再び使う形は拒否される', async () => {
    // docs/grammar/syntax.md「ハンドラの再利用」の末尾。$handler: ${reuse} は本体を閉包で渡すので、
    // 入れ子にすると reuse が自分に渡る閉包の中で自分を呼ぶ循環になる。
    await expect(
      run(`
$let:
  reuse:
    $fn: run
    $body:
      $handler:
        std.fail: {$fn: _, $body: 0}
      $in: {$.run: null}
$in:
  $handler: "\${reuse}"
  $in:
    $handler: "\${reuse}"
    $in: 1
`),
    ).rejects.toThrow(SELF_APP);
  });
});

describe('公認イディオムの受理', () => {
  it('関数とデータを $if で分岐し、$handler: ${std.list} の下で呼ぶ形は通る', async () => {
    await expect(
      run(
        `
$do:
- $let:
    chosen:
      $if: {$std.param: fancy}
      $then:
        $fn: x
        $body: {$std.each: [1, 2]}
      $else: 0
- $handler: "\${std.list}"
  $in: {$.chosen: 0}
`,
        { params: { fancy: true } },
      ),
    ).resolves.toEqual([1, 2]);
  });

  it('リテラルの列からの $std.each で関数を選んで呼ぶ形は通る', async () => {
    await expect(
      run(`
$handler: "\${std.list}"
$in:
  $do:
  - $let:
      f: {$fn: x, $body: '\${x + 1}'}
      g: {$fn: x, $body: '\${x * 2}'}
  - $let:
      h: {$std.each: ['\${f}', '\${g}']}
  - $.h: 10
`),
    ).resolves.toEqual([11, 20]);
  });

  it('部分適用と高階の引数は通る', async () => {
    await expect(
      run(`
$do:
- $let:
    codes: {ja: 81, us: 1}
    look:
      $fn: [m, k]
      $body:
        $std.lookup:
          in: \${m}
          key: \${k}
- $let:
    dial:
      $.look: \${codes}
- $.dial: ja
`),
    ).resolves.toBe(81);
  });

  it('節が関数を返し、$resume の値（継続）を適用する形（状態ハンドラの骨格）は通る', async () => {
    // std.state の展開の縮図。継続 k の適用は循環に数えない（ハンドラの畳み込みで停止する）。
    await expect(
      run(`
$do:
- $let:
    run:
      $handler:
        get:
          $fn: _
          $body:
            $fn: s
            $body:
              $let:
                k: {$resume: '\${s}'}
              $in: {$.k: '\${s}'}
        return:
          $fn: v
          $body: {$fn: s, $body: '\${v}'}
      $in:
        $do:
        - $let: {a: {$.get: null}}
        - \${a + 1}
- $.run: 41
`),
    ).resolves.toBe(42);
  });

  it('処理系の関数（std.list・std.state・std.collect）の入れ子は循環に数えない', async () => {
    // ハンドラを立てる std の関数は $fn ではないので、重ねても自己適用の制限を受けない。
    await expect(
      run(`
$handler: "\${std.list}"
$in:
  $do:
  - $let:
      pairs:
        $handler: "\${std.list}"
        $in: {$std.each: [1, 2]}
  - $let:
      total:
        $handler: {$std.state: {n: 0}}
        $in:
          $std.collect:
            in: '\${pairs}'
            with: {$fn: x, $body: ['\${x}']}
  - {pairs: '\${pairs}', total: '\${total}'}
`),
    ).resolves.toEqual([{ pairs: [1, 2], total: [1, 2] }]);
  });

  it('データだけの状態の貫流は通る', async () => {
    await expect(
      run(`
$do:
- $std.set: {n: 1}
- $let: {v: {$std.get: n}}
- \${v + 1}
`),
    ).resolves.toBe(2);
  });
});

describe('ホストの実装への閉包', () => {
  it('どの節にも現れない演算の引数に閉包が流れうる文書は評価前に拒否される', async () => {
    const calls: Value[] = [];
    await expect(
      run(
        `
$do:
- $let: {f: {$fn: x, $body: '\${x}'}}
- $my.op: \${f}
`,
        {
          ops: {
            'my.op': (v) => {
              calls.push(v);
              return null;
            },
          },
        },
      ),
    ).rejects.toThrow('a function value cannot be passed to a host operation: $my.op');
    expect(calls).toEqual([]); // ホストには渡っていない
  });

  it('ホストの関数の引数でも同じく拒否される（横取りできないので節の逃げ道もない）', async () => {
    const calls: Value[] = [];
    await expect(
      run(
        `
$do:
- $let: {f: {$fn: x, $body: '\${x}'}}
- $svc.f: \${f}
`,
        {
          functions: {
            'svc.f': (v) => {
              calls.push(v);
              return null;
            },
          },
        },
      ),
    ).rejects.toThrow('a function value cannot be passed to a host function: $svc.f');
    expect(calls).toEqual([]);
  });

  it('演算の値を渡す形も同じ検査に掛かる', async () => {
    await expect(
      run('{$vault.write: "\${std.each}"}', { ops: { 'vault.write': () => null } }),
    ).rejects.toThrow('a function value cannot be passed to a host operation: $vault.write');
  });

  it('文書内の節が処理する演算なら、引数の閉包は通る', async () => {
    await expect(
      run(
        `
$do:
- $let: {f: {$fn: x, $body: '\${x + 1}'}}
- $handler:
    my.op:
      $fn: g
      $body: {$.g: 41}
  $in:
    $my.op: \${f}
`,
        { ops: { 'my.op': () => null } },
      ),
    ).resolves.toBe(42);
  });
});

describe('検査の計算量', () => {
  it(
    '深い入れ子の関数と呼び出しでも爆発しない',
    async () => {
      let body: unknown = '${x}';
      for (let i = 0; i < 20; i++) {
        body = {
          $do: [
            { $let: { f: { $fn: 'x', $body: body } } },
            { $if: false, $then: { '$.f': 1 }, $else: { '$.f': 2 } },
          ],
        };
      }
      await expect(evaluate(body)).resolves.toBe(2);
    },
    1000,
  );

  it(
    '横に広いリテラル構造でも爆発しない',
    async () => {
      // 1000 キーのマッピングを引数に渡して 1000 回呼ぶ。セルと原子が線形に収まることを固定する。
      const wide: Record<string, unknown> = {};
      for (let i = 0; i < 1000; i++) wide[`k${i}`] = i;
      const stmts: unknown[] = [
        { $let: { m: wide, pick: { $fn: 'x', $body: '${x.k0}' } } },
      ];
      for (let i = 0; i < 1000; i++) stmts.push({ '$.pick': '${m}' });
      await expect(evaluate({ $do: stmts })).resolves.toBe(0);
    },
    1000,
  );
});
