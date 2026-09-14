/**
 * 検証テスト：docs/grammar.md（草案 0.13）が定める展開を文書として書き、同じ本体を
 * 処理系の組み込み（`std` の関数と導出形）で評価した結果と比較する。
 *
 * 仕様（grammar.md「std」節）：
 *   処理系は等価な組み込みで最適化してよいが、観測できる振る舞い（値、作用、ログの順序）は
 *   展開と一致しなければならない。
 *
 * 本体の閉包を受け取る関数（std.list / std.mapping / std.first / std.state）は、
 * 仕様どおり文書の中の関数として書き、`$handler: ${名前}` の形で使う。
 */
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { evaluate, type EvaluateOptions } from '../src/eval.js';
import type { Value } from '../src/types.js';

const run = (src: string, options?: EvaluateOptions): Promise<Value> =>
  evaluate(parse(src), options);

/**
 * yaml の各行を col 桁ぶんインデントし、先頭に改行を付けて返す。
 * `key:${block(body, n)}` の形で、`key:` の値としてブロックの本体を任意の深さに埋め込める。
 */
function block(yaml: string, col: number): string {
  const pad = ' '.repeat(col);
  return (
    '\n' +
    yaml
      .trim()
      .split('\n')
      .map((l) => (l.length > 0 ? pad + l : l))
      .join('\n')
  );
}

// -----------------------------------------------------------------------------
// 仕様に書かれた std の関数の値（本体の閉包を受け取る関数）
// -----------------------------------------------------------------------------

/** grammar.md「std.list の値」 */
const LIST_FN = `
$fn: run
$body:
  $handler:
    std.each:
      $fn: xs
      $body:
        $std.collect:
          in: \${xs}
          with:
            $fn: x
            $body:
              $resume: \${x}
    return:
      $fn: x
      $body:
      - \${x}
  $in: {$.run: null}
`;

/** grammar.md「std.mapping の値」 */
const MAPPING_FN = `
$fn: run
$body:
  $std.collect:
    in:
      $handler: \${std.list}
      $in: {$.run: null}
    with:
      $fn: e
      $body:
      - \${e}
    into: mapping
`;

/** grammar.md「std.state の値」（初期値と本体の閉包をとるカリー化された関数） */
const STATE_FN = `
$fn: [init, run]
$body:
  $let:
    step:
      $handler:
        std.get:
          $fn: name
          $body:
            $fn: s
            $body:
              $let:
                hits:
                  $std.collect:
                    in: \${s}
                    with:
                      $fn: e
                      $body:
                        $if: \${e.key == name}
                        $then:
                        - \${e.value}
                        $else: []
                k:
                  $resume: \${hits[0]}
              $in:
                $.k: \${s}
        std.set:
          $fn: m
          $body:
            $fn: s
            $body:
              $let:
                s2:
                  $std.collect:
                    in:
                    - \${m}
                    - \${s}
                    with:
                      $fn: part
                      $body:
                        $std.collect:
                          in: \${part}
                          with:
                            $fn: e
                            $body:
                            - \${e}
                k:
                  $resume: null
              $in:
                $.k: \${s2}
        return:
          $fn: x
          $body:
            $fn: s
            $body: \${x}
      $in: {$.run: null}
  $in:
    $.step: \${init}
`;

/**
 * std.first の展開（docs/reference/std.first.md）。
 * 成功の印を持ち回る外側の `$handler` と、選択と失敗を処理する内側の `$handler` の二段。
 * 印の持ち回りは外側がローカル作用として宣言するので、本体の std.get / std.set と衝突しない。
 */
/**
 * 印を持ち回る外側の `$handler`（節は状態変換関数を返し、印はローカル作用の宣言で運ぶ）と、
 * 選択と失敗を処理する内側の `$handler` の二段。値は初期値 false を渡して得る。
 */
const FIRST_STEP = `
$handler:
  taken:
    $fn: _
    $body:
      $fn: t
      $body:
        $let:
          k:
            $resume: \${t}
        $in:
          $.k: \${t}
  mark:
    $fn: _
    $body:
      $fn: t
      $body:
        $let:
          k:
            $resume: null
        $in:
          $.k: true
  return:
    $fn: x
    $body:
      $fn: t
      $body: \${x}
$in:
  $handler:
    std.each:
      $fn: xs
      $body:
        $std.collect:
          in: \${xs}
          with:
            $fn: x
            $body:
              $if: {$.taken: null}
              $then: []
              $else:
                $resume: \${x}
    std.fail:
      $fn: _
      $body: []
    return:
      $fn: x
      $body:
        $do:
        - {$.mark: null}
        - - \${x}
  $in: {$.run: null}
`;

const FIRST_FN = `
$fn: run
$body:
  $let:
    step:${block(FIRST_STEP, 6)}
    results: {$.step: false}
  $in: \${results[0]}
`;

/** 仕様の関数を `名前` に束縛して、`$handler: ${名前}` の下で本体を評価する文書。 */
function viaFn(name: string, fn: string, body: string): string {
  return `
$let:
  ${name}:${block(fn, 4)}
$in:
  $handler: \${${name}}
  $in:${block(body, 4)}
`;
}

/** 組み込みの `$handler: ${std.名前}` の下で本体を評価する文書。 */
function viaBuiltin(name: string, body: string): string {
  return `
$handler: \${std.${name}}
$in:${block(body, 2)}
`;
}

// -----------------------------------------------------------------------------
// 1. std.state
// -----------------------------------------------------------------------------

/** 仕様の std.state を束縛し、部分適用 `{$.myState: 初期値}` を `$handler` の式に置く。 */
function stateExpanded(initFlow: string, body: string): string {
  return `
$let:
  myState:${block(STATE_FN, 4)}
$in:
  $handler: {$.myState: ${initFlow}}
  $in:${block(body, 4)}
`;
}

/** 組み込みの `$handler: {$std.state: 初期値}`。 */
function stateBuiltin(initFlow: string, body: string): string {
  return `
$handler: {$std.state: ${initFlow}}
$in:${block(body, 2)}
`;
}

describe('std.state の展開との等価性', () => {
  it('get / set / get の並びが一致する', async () => {
    const body = `
$do:
- $let:
    a: {$std.get: n}
- $std.set:
    n: \${a + 1}
- {$std.get: n}
`;
    const expanded = await run(stateExpanded('{n: 41}', body));
    const builtin = await run(stateBuiltin('{n: 41}', body));
    expect(expanded).toEqual(builtin);
    expect(builtin).toBe(42);
  });

  it('未作成のセルへの set と複数セルが一致する', async () => {
    const body = `
$do:
- $std.set:
    x: 1
    y: 2
- $let:
    a: {$std.get: x}
    b: {$std.get: y}
- \${a + b}
`;
    const expanded = await run(stateExpanded('{}', body));
    const builtin = await run(stateBuiltin('{}', body));
    expect(expanded).toEqual(builtin);
    expect(builtin).toBe(3);
  });

  it('未初期化セルの読み出しはどちらも失敗する', async () => {
    const body = '{$std.get: nope}';
    await expect(run(stateExpanded('{}', body))).rejects.toThrow();
    await expect(run(stateBuiltin('{}', body))).rejects.toThrow();
  });

  it('状態のハンドラの外側に置いた $default は捕まえ、内側では捕まえない（std.get.md）', async () => {
    // 未初期化セルの失敗は std.state の展開の節の本体（${hits[0]}）が起こすので、
    // 状態のハンドラより「外側」でしか捕まらない（$handler の規則）。
    await expect(
      run(`
$handler: {$std.state: {}}
$in: {$std.get: nope}
$default: null
`),
    ).resolves.toBe(null);
    await expect(
      run(`
$handler: {$std.state: {}}
$in:
  $std.get: nope
  $default: null
`),
    ).rejects.toThrow('failure: uninitialized cell: nope');
  });

  it('貫流（展開した state で std.list を包む）が組み込みの貫流と一致する', async () => {
    const inner = `
$handler: \${std.list}
$in:
  $do:
  - $std.set: {n: 10}
  - $let:
      x: {$std.each: [a, b]}
      i: {$std.get: n}
  - $std.set:
      n: \${i + 1}
  - \${x}\${i}
`;
    const expanded = await run(stateExpanded('{n: 0}', inner));
    const builtin = await run(stateBuiltin('{n: 0}', inner));
    expect(expanded).toEqual(builtin);
    expect(builtin).toEqual(['a10', 'b11']);
  });

  it('分岐点で分かれる（std.list の内側に展開した state を置く）が組み込みと一致する', async () => {
    const inner = `
$do:
- $std.set: {n: 10}
- $let:
    x: {$std.each: [a, b]}
    i: {$std.get: n}
- $std.set:
    n: \${i + 1}
- \${x}\${i}
`;
    const expanded = await run(`
$handler: \${std.list}
$in:${block(stateExpanded('{n: 0}', inner), 2)}
`);
    const builtin = await run(`
$handler: \${std.list}
$in:${block(stateBuiltin('{n: 0}', inner), 2)}
`);
    expect(expanded).toEqual(builtin);
    expect(builtin).toEqual(['a10', 'b10']);
  });
});

// -----------------------------------------------------------------------------
// 2. std.list
// -----------------------------------------------------------------------------

describe('std.list の展開との等価性', () => {
  it('二重の選択の全分岐が文書順に並ぶ', async () => {
    const body = `
$do:
- $let:
    x: {$std.each: [1, 2]}
    y: {$std.each: [10, 20]}
- \${x + y}
`;
    const expanded = await run(viaFn('myList', LIST_FN, body));
    const builtin = await run(viaBuiltin('list', body));
    expect(expanded).toEqual(builtin);
    expect(builtin).toEqual([11, 21, 12, 22]);
  });

  it('内側に選択がなければ要素 1 のリストになる', async () => {
    const body = '42';
    expect(await run(viaFn('myList', LIST_FN, body))).toEqual([42]);
    expect(await run(viaBuiltin('list', body))).toEqual([42]);
  });

  it('$std.where の打ち切りが分岐を消す（空の $std.each）', async () => {
    const body = `
$do:
- $for:
    x: [1, 2, 3, 4]
- $std.where: \${x % 2 == 0}
- \${x}
`;
    const expanded = await run(viaFn('myList', LIST_FN, body));
    const builtin = await run(viaBuiltin('list', body));
    expect(expanded).toEqual(builtin);
    expect(builtin).toEqual([2, 4]);
  });

  it('分岐の中の失敗は節にないので全体の失敗として伝播する', async () => {
    const body = `
$do:
- $for:
    x: [1, 2]
- $if: \${x == 2}
  $then: {$std.fail: boom}
  $else: \${x}
`;
    await expect(run(viaFn('myList', LIST_FN, body))).rejects.toThrow(/boom/);
    await expect(run(viaBuiltin('list', body))).rejects.toThrow(/boom/);
  });
});

// -----------------------------------------------------------------------------
// 3. std.mapping
// -----------------------------------------------------------------------------

describe('std.mapping の展開との等価性', () => {
  it('grammar.md の svc- 用例（std.each によるマッピングの分解と組み立て）が一致する', async () => {
    const body = `
$do:
- $let:
    e: {$std.each: {web: 80, db: 5432}}
- key: svc-\${e.key}
  value: \${e.value}
`;
    const expanded = await run(viaFn('myMapping', MAPPING_FN, body));
    const builtin = await run(viaBuiltin('mapping', body));
    expect(expanded).toEqual(builtin);
    expect(builtin).toEqual({ 'svc-web': 80, 'svc-db': 5432 });
    expect(Object.keys(expanded as object)).toEqual(['svc-web', 'svc-db']);
  });

  it('$std.where によるエントリの省略が一致する', async () => {
    const body = `
$do:
- $let:
    e: {$std.each: {web: 80, db: 5432, cache: 0}}
- $std.where: \${e.value > 0}
- key: \${e.key}
  value: \${e.value}
`;
    const expanded = await run(viaFn('myMapping', MAPPING_FN, body));
    const builtin = await run(viaBuiltin('mapping', body));
    expect(expanded).toEqual(builtin);
    expect(builtin).toEqual({ web: 80, db: 5432 });
  });

  it('キー重複はどちらもエラーになる（メッセージの一致は要求しない）', async () => {
    const body = `
$do:
- $let:
    e: {$std.each: [a, b]}
- key: dup
  value: \${e}
`;
    await expect(run(viaFn('myMapping', MAPPING_FN, body))).rejects.toThrow();
    await expect(run(viaBuiltin('mapping', body))).rejects.toThrow();
  });
});

// -----------------------------------------------------------------------------
// 4. std.first
// -----------------------------------------------------------------------------

describe('std.first の展開との等価性', () => {
  it('参照文書の用例（パラメータ未渡しで info に落ちる）が一致する', async () => {
    const body = `
$do:
- $let:
    v: {$std.each: [{$std.param: log_level, $default: null}, info]}
- $std.where: \${v != null}
- \${v}
`;
    const expanded = await run(viaFn('myFirst', FIRST_FN, body));
    const builtin = await run(viaBuiltin('first', body));
    expect(expanded).toEqual(builtin);
    expect(builtin).toBe('info');
  });

  it('早期打ち切り: 最初の成功より後の分岐は評価されず、そのログも現れない', async () => {
    // v=1 は std.fail で失敗（ログに達する前に打ち切られる）。
    // v=2 は成功し、ログ 'reached-2' を残す。
    // v=3 は taken 済みなので $resume すら呼ばれず、'reached-3' はそもそも評価されない。
    const body = `
$do:
- $let:
    v: {$std.each: [1, 2, 3]}
- $if: \${v == 1}
  $then:
    $std.fail: boom
  $else: null
- $if: \${v == 2}
  $then:
    $std.log: reached-2
  $else: null
- $if: \${v == 3}
  $then:
    $std.log: reached-3
  $else: null
- \${v}
`;
    const expandedLogs: Value[] = [];
    const builtinLogs: Value[] = [];
    const expanded = await run(viaFn('myFirst', FIRST_FN, body), {
      onLog: (v) => expandedLogs.push(v),
    });
    const builtin = await run(viaBuiltin('first', body), { onLog: (v) => builtinLogs.push(v) });
    expect(expanded).toEqual(builtin);
    expect(builtin).toBe(2);
    expect(expandedLogs).toEqual(['reached-2']);
    expect(builtinLogs).toEqual(['reached-2']);
  });

  it('全分岐が失敗すればどちらも失敗する（メッセージの一致は要求しない）', async () => {
    const body = `
$do:
- $let:
    v: {$std.each: [1, 2]}
- $std.fail: nope
`;
    await expect(run(viaFn('myFirst', FIRST_FN, body))).rejects.toThrow();
    await expect(run(viaBuiltin('first', body))).rejects.toThrow();
  });
});

// -----------------------------------------------------------------------------
// 5. $default（grammar.md「$default」節）
//   {主形 ∪ {$default: 式}} ≡ {$handler: {std.fail: {$fn: 私的名, $body: 式}}, $in: 主形}
// -----------------------------------------------------------------------------

describe('$default の展開との等価性', () => {
  it('失敗を既定値に置き換える形が literal な std.fail の節と一致する', async () => {
    const sugar = await run(`
$do:
- $let:
    m: {}
- $std.lookup: {in: "\${m}", key: nope}
  $default: fallback
`);
    const expanded = await run(`
$do:
- $let:
    m: {}
- $handler:
    std.fail: {$fn: _, $body: fallback}
  $in:
    $std.lookup: {in: "\${m}", key: nope}
`);
    expect(sugar).toEqual(expanded);
    expect(sugar).toBe('fallback');
  });

  it('打ち切りの定型（$default に $std.where: false）が展開と一致する', async () => {
    const rows = `
  row:
  - {date: d1, code: c1}
  - {date: d2}
  - {date: d3, code: c3}
`;
    const sugar = await run(`
$handler: \${std.list}
$for:${rows}date: \${row.date}
code:
  $std.lookup: {in: "\${row}", key: code}
  $default: {$std.where: false}
`);
    const expanded = await run(`
$handler: \${std.list}
$for:${rows}date: \${row.date}
code:
  $handler:
    std.fail:
      $fn: _
      $body: {$std.where: false}
  $in:
    $std.lookup: {in: "\${row}", key: code}
`);
    expect(sugar).toEqual(expanded);
    expect(sugar).toEqual([
      { date: 'd1', code: 'c1' },
      { date: 'd3', code: 'c3' },
    ]);
  });

  it('std.first の中で使った打ち切りの定型も、外側の選択のハンドラまで打ち切りが届く', async () => {
    // row が {} の分岐は $default の {$std.where: false} が失敗を打ち切りに変える。
    // 打ち切りは選択なので $default 自身のハンドラでは処理されず、外側（std.first）に届く。
    const sugar = await run(`
$handler: \${std.first}
$in:
  $do:
  - $let:
      row: {$std.each: [{}, {code: c3}]}
  - $std.lookup: {in: "\${row}", key: code}
    $default: {$std.where: false}
`);
    const expanded = await run(`
$handler: \${std.first}
$in:
  $do:
  - $let:
      row: {$std.each: [{}, {code: c3}]}
  - $handler:
      std.fail:
        $fn: _
        $body: {$std.where: false}
    $in:
      $std.lookup: {in: "\${row}", key: code}
`);
    expect(expanded).toEqual(sugar);
    expect(sugar).toBe('c3');
  });

  it('本体が失敗しなければ $default は素通しであり、その作用も起きない', async () => {
    const logs: Value[] = [];
    const sugar = await run(
      `
$do:
- $let:
    m: {a: 5}
- $std.lookup: {in: "\${m}", key: a}
  $default:
    $do:
    - $std.log: evaluated
    - 0
`,
      { onLog: (v) => logs.push(v) },
    );
    expect(sugar).toBe(5);
    expect(logs).toEqual([]);
  });

  it('$default の式は $ 式の外側にあるので、頭が導入する束縛を見られない', async () => {
    await expect(
      run(`
$let:
  x: 1
$in: {$std.fail: boom}
$default: \${x}
`),
    ).rejects.toThrow('undefined reference: x');
  });
});

// -----------------------------------------------------------------------------
// 6. std.where（grammar.md「std.where」節）
// -----------------------------------------------------------------------------

describe('std.where の展開との等価性', () => {
  it('ガードが {$if: 条件, $then: null, $else: {$std.each: []}} と一致する', async () => {
    const sugar = await run(`
$handler: \${std.list}
$in:
  $do:
  - $let:
      x: {$std.each: [1, 2, 3, 4]}
  - $std.where: \${x % 2 == 0}
  - \${x}
`);
    const expanded = await run(`
$handler: \${std.list}
$in:
  $do:
  - $let:
      x: {$std.each: [1, 2, 3, 4]}
  - $if: \${x % 2 == 0}
    $then: null
    $else: {$std.each: []}
  - \${x}
`);
    expect(expanded).toEqual(sugar);
    expect(sugar).toEqual([2, 4]);
  });

  it('条件が真のときの値はどちらも null である', async () => {
    expect(await run('{$handler: "${std.list}", $in: {$std.where: true}}')).toEqual([null]);
    expect(
      await run('{$handler: "${std.list}", $in: {$if: true, $then: null, $else: {$std.each: []}}}'),
    ).toEqual([null]);
  });
});

// -----------------------------------------------------------------------------
// 7. fold の導出（std.collect + std.state、grammar.md「std.collect」節）
// -----------------------------------------------------------------------------

describe('fold の導出（std.collect + std.state）', () => {
  it('[3, 1, 4, 1, 5] の総和が 14 になる', async () => {
    await expect(
      run(`
$handler: {$std.state: {acc: 0}}
$in:
  $do:
  - $std.collect:
      in: [3, 1, 4, 1, 5]
      with:
        $fn: x
        $body:
          $do:
          - $let:
              a: {$std.get: acc}
          - $std.set:
              acc: \${a + x}
          - []
  - {$std.get: acc}
`),
    ).resolves.toBe(14);
  });
});

// -----------------------------------------------------------------------------
// 8. $fn の列（カリー化の導出形、grammar.md「引数名の列と部分適用」節）
// -----------------------------------------------------------------------------

describe('$fn の列のカリー化展開', () => {
  it('列の形と入れ子の $fn は同じ値になる（3 引数、順に部分適用）', async () => {
    const use = `
- $let:
    f1: {$.f: 100}
    f2: {$.f1: 20}
- $.f2: 3
`;
    const listed = await run(`
$do:
- $let:
    f:
      $fn: [a, b, c]
      $body: ${'$'}{a + b + c}${use}`);
    const nested = await run(`
$do:
- $let:
    f:
      $fn: a
      $body:
        $fn: b
        $body:
          $fn: c
          $body: ${'$'}{a + b + c}${use}`);
    expect(listed).toBe(123);
    expect(nested).toBe(123);
  });

  it('部分適用の引数の作用はその位置で一度だけ生じ、本体の作用は完成時に生じる', async () => {
    const logs: Value[] = [];
    const result = await run(
      `
$do:
- $let:
    tag:
      $fn: [prefix, x]
      $body:
        $do:
        - $std.log: body
        - ${'$'}{prefix}-${'$'}{x}
- $let:
    warn:
      $.tag:
        $do:
        - $std.log: fixing
        - w
- $std.log: fixed
- $let:
    a: {$.warn: 1}
    b: {$.warn: 2}
- - ${'$'}{a}
  - ${'$'}{b}
`,
      { onLog: (v) => logs.push(v) },
    );
    expect(result).toEqual(['w-1', 'w-2']);
    // fixing は部分適用の位置で一度だけ。本体の body は完成のたびに一度ずつ。
    expect(logs).toEqual(['fixing', 'fixed', 'body', 'body']);
  });
});

// -----------------------------------------------------------------------------
// 9. std.lookup の展開（grammar.md「std.lookup」節）
// -----------------------------------------------------------------------------

/** grammar.md「std.lookup の値」に引数を渡した形。inFlow はフロー形式（例: "{a: 1}"）。 */
function lookupExpanded(inFlow: string, keyScalar: string): string {
  return `
$let:
  myLookup:
    $fn: arg
    $body:
      $handler: \${std.first}
      $in:
        $do:
        - $for:
            e: \${arg.in}
        - $std.where: \${e.key == arg.key}
        - \${e.value}
$in:
  $.myLookup:
    in: ${inFlow}
    key: ${keyScalar}
`;
}

describe('std.lookup の展開との等価性', () => {
  it('キーが在れば、展開と組み込みが同じ値になる', async () => {
    const expanded = await run(lookupExpanded('{a: 1, b: 2}', 'b'));
    const builtin = await run(`
$std.lookup:
  in: {a: 1, b: 2}
  key: b
`);
    expect(builtin).toEqual(expanded);
    expect(builtin).toBe(2);
  });

  it('無いキーは、展開も組み込みも失敗になる（失敗の値の文言だけは仕様が展開に委ねない）', async () => {
    await expect(run(lookupExpanded('{a: 1}', 'x'))).rejects.toThrow(/failure:/);
    await expect(
      run(`
$std.lookup:
  in: {a: 1}
  key: x
`),
    ).rejects.toThrow(/failure: missing key 'x'/);
  });

  it('無いキーの失敗は、展開も組み込みも $default で同じ既定値になる', async () => {
    const expanded = await run(`${lookupExpanded('{a: 1}', 'x').trim()}
$default: fallback
`);
    const builtin = await run(`
$std.lookup:
  in: {a: 1}
  key: x
$default: fallback
`);
    expect(expanded).toBe('fallback');
    expect(builtin).toBe('fallback');
  });
});

// -----------------------------------------------------------------------------
// 10. $do の文に置いた文脈の導入の展開（grammar.md「$do」）
//   {$do: [{$handler: 式}, 残り...]} ≡ {$handler: 式, $in: {$do: [残り...]}}
// -----------------------------------------------------------------------------

describe('$do の文に置いた文脈の導入の展開との等価性', () => {
  it('$in を省いた $handler は残りの文を包む $handler と一致する（値もログの順序も）', async () => {
    const statement = `
$do:
- $handler:
    std.fail:
      $fn: m
      $body:
        $do:
        - $std.log: 'caught: \${m}'
        - recovered
- $std.log: before
- {$std.fail: boom}
`;
    const expanded = `
$handler:
  std.fail:
    $fn: m
    $body:
      $do:
      - $std.log: 'caught: \${m}'
      - recovered
$in:
  $do:
  - $std.log: before
  - {$std.fail: boom}
`;
    const logsA: Value[] = [];
    const logsB: Value[] = [];
    const a = await run(statement, { onLog: (v) => logsA.push(v) });
    const b = await run(expanded, { onLog: (v) => logsB.push(v) });
    expect(a).toEqual(b);
    expect(a).toBe('recovered');
    expect(logsA).toEqual(logsB);
    expect(logsA).toEqual(['before', 'caught: boom']);
  });

  it('$in を省いた std.state のハンドラは、残りの文を $in に書いた形と一致する（初期値は文の位置で評価される）', async () => {
    const statement = `
$do:
- $let:
    base: 41
- $handler:
    $std.state:
      n: \${base}
- $let:
    v: {$std.get: n}
- \${v + 1}
`;
    const expanded = `
$do:
- $let:
    base: 41
- $handler:
    $std.state:
      n: \${base}
  $in:
    $do:
    - $let:
        v: {$std.get: n}
    - \${v + 1}
`;
    const a = await run(statement);
    expect(a).toEqual(await run(expanded));
    expect(a).toBe(42);
  });
});

// -----------------------------------------------------------------------------
// 11. std.merge の展開（grammar.md「std.merge」節）
//   値は後勝ち、キーの位置は初出。a 側は自分のキーをその位置のまま並べ、b に同じキーが
//   在ればその値で差し替える。b 側は a に無いキーだけを後ろに足す。
// -----------------------------------------------------------------------------

describe('std.merge の展開との等価性', () => {
  it('後勝ち・初出の位置（grammar.md 用例）が展開と一致する（キー順まで）', async () => {
    const expanded = await run(`
$let:
  a: {b: 2, a: 1, keep: base}
  b: {b: 9, c: 3}
$handler: \${std.mapping}
$in:
  $do:
  - $for:
      phase: [0, 1]
  - $let:
      src:
        $if: \${phase == 0}
        $then: \${a}
        $else: \${b}
  - $for:
      e: \${src}
  - $let:
      fresh:
        $if: \${phase == 0}
        $then: true
        $else:
          $let:
            _:
              $std.lookup:
                in: \${a}
                key: \${e.key}
          $in: false
          $default: true
  - $std.where: \${fresh}
  - key: \${e.key}
    value:
      $if: \${phase == 0}
      $then:
        $std.lookup:
          in: \${b}
          key: \${e.key}
        $default: \${e.value}
      $else: \${e.value}
`);
    const builtin = await run(`
$let:
  a: {b: 2, a: 1, keep: base}
  b: {b: 9, c: 3}
$in:
  $std.merge:
  - \${a}
  - \${b}
`);
    expect(builtin).toEqual(expanded);
    expect(Object.keys(builtin as object)).toEqual(Object.keys(expanded as object));
    expect(builtin).toEqual({ b: 9, a: 1, keep: 'base', c: 3 });
    expect(Object.keys(builtin as object)).toEqual(['b', 'a', 'keep', 'c']);
  });
});

// -----------------------------------------------------------------------------
// 12. $for の展開（grammar.md「$for」節）
//   {$for: {x: 式}} ∪ 残り ≡ {$let: {x: {$std.each: 式}}} ∪ 残り
// -----------------------------------------------------------------------------

describe('$for の展開との等価性', () => {
  it('後の束縛が先の束縛の選んだ要素を見る（entry/label の flatMap）が一致する', async () => {
    const sugar = await run(`
$handler: \${std.list}
$let:
  forms:
    a: [1, 2]
    b: [3]
$for:
  entry: \${forms}
  label: \${entry.value}
$in: \${entry.key}\${label}
`);
    const expanded = await run(`
$handler: \${std.list}
$let:
  forms:
    a: [1, 2]
    b: [3]
  entry: {$std.each: "\${forms}"}
  label: {$std.each: "\${entry.value}"}
$in: \${entry.key}\${label}
`);
    expect(sugar).toEqual(expanded);
    expect(sugar).toEqual(['a1', 'a2', 'b3']);
  });

  it('展開の $std.each は展開先の環境で解決するので、std を隠せば $for もそれに従う', async () => {
    await expect(
      run(`
$handler: \${std.list}
$in:
  $let:
    std: {each: "\${std.each}"}
  $for:
    x: [1, 2]
  $in: \${x}
`),
    ).resolves.toEqual([1, 2]);
  });
});
