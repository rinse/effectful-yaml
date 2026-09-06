/**
 * 検証テスト：docs/grammar.md（草案 0.11）が定める std の派生ハンドラ
 * （$std.list / $std.mapping / $std.first / $std.state / $std.opt）の
 * 「$with と $collect への展開」を文書として書き、同じ本体を組み込みで評価した
 * 結果と比較する。
 *
 * 仕様（grammar.md「std の派生ハンドラ」節）：
 *   実装は等価な組み込みで最適化してよいが、観測できる振る舞い（値、作用、ログの順序）は
 *   展開と一致しなければならない。
 *
 * $std.list の展開との等価性テストは tests/eval.test.ts の末尾に既にあるので、ここでは
 * 重複させない。
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
// 1a. $std.state の展開（grammar.md「std の派生ハンドラ」節 + docs/reference/std.state.md）
// -----------------------------------------------------------------------------

/** `$std.state: initFlow, $in: body` の展開。initFlow はフロー形式（例: "{n: 0}"）。 */
function stateExpanded(initFlow: string, body: string): string {
  return `
$do:
- $let:
    init: ${initFlow}
    run:
      $in:${block(body, 8)}
      $with:
        std.get:
          $fn: name
          $body:
            $fn: s
            $body:
              $do:
              - $let:
                  hits:
                    $collect: \${s}
                    $with:
                      $fn: e
                      $body:
                        $if: \${e.key == name}
                        $then:
                        - \${e.value}
                        $else: []
              - $let:
                  k:
                    $resume: \${hits[0]}
              - $.k: \${s}
        std.set:
          $fn: m
          $body:
            $fn: s
            $body:
              $do:
              - $let:
                  empty: []
              - $let:
                  kept:
                    $collect: \${s}
                    $with:
                      $fn: e
                      $body:
                        $do:
                        - $let:
                            dup:
                              $collect: \${m}
                              $with:
                                $fn: e2
                                $body:
                                  $if: \${e2.key == e.key}
                                  $then:
                                  - null
                                  $else: []
                        - $if: \${dup == empty}
                          $then:
                          - \${e}
                          $else: []
                  ments:
                    $collect: \${m}
                    $with:
                      $fn: e2
                      $body:
                      - \${e2}
                  alle:
                    $collect:
                    - \${kept}
                    - \${ments}
                    $with:
                      $fn: ys
                      $body: \${ys}
                  s2:
                    $collect: \${alle}
                    $with:
                      $fn: p
                      $body:
                      - \${p}
                    $into: mapping
              - $let:
                  k:
                    $resume: null
              - $.k: \${s2}
        return:
          $fn: x
          $body:
            $fn: s
            $body: \${x}
- $.run: \${init}
`;
}

/** 組み込みの `$std.state: initFlow, $in: body`。 */
function stateBuiltin(initFlow: string, body: string): string {
  return `
$std.state: ${initFlow}
$in:${block(body, 2)}
`;
}

describe('$std.state の展開との等価性', () => {
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

  it('$std.opt の内側に $std.state を置けば捕まり、逆の入れ子では捕まらない（組み込み、std.get.md）', async () => {
    // 未初期化セルの失敗は $std.state の展開の節の本体（${hits[0]}）が起こすので、
    // 状態のハンドラより「外側」でしか捕まらない（$with の規則）。
    await expect(
      run(`
$std.opt:
  $std.state: {}
  $in: {$std.get: nope}
`),
    ).resolves.toBe(null);
    await expect(
      run(`
$std.state: {}
$in:
  $std.opt: {$std.get: nope}
`),
    ).rejects.toThrow('failure: uninitialized cell: nope');
  });

  it('貫流（展開した state で $std.list を包む）が組み込みの貫流と一致する', async () => {
    const inner = `
$std.list:
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

  it('分岐点で分かれる（$std.list の内側に展開した state を置く）が組み込みと一致する', async () => {
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
$std.list:${block(stateExpanded('{n: 0}', inner), 2)}
`);
    const builtin = await run(`
$std.list:
  $std.state: {n: 0}
  $in:${block(inner, 4)}
`);
    expect(expanded).toEqual(builtin);
    expect(builtin).toEqual(['a10', 'b10']);
  });
});

// -----------------------------------------------------------------------------
// 1b. $std.mapping の展開（grammar.md「std の派生ハンドラ」節）
// -----------------------------------------------------------------------------

function mappingExpanded(body: string): string {
  return `
$in:${block(body, 2)}
$with:
  std.each:
    $fn: xs
    $body:
      $collect: \${xs}
      $into: mapping
      $with:
        $fn: x
        $body:
          $collect:
            $resume: \${x}
          $with:
            $fn: p
            $body:
            - \${p}
  return:
    $fn: x
    $body:
      $collect:
      - \${x}
      $with:
        $fn: p
        $body:
        - \${p}
      $into: mapping
`;
}

function mappingBuiltin(body: string): string {
  return `
$std.mapping:${block(body, 2)}
`;
}

describe('$std.mapping の展開との等価性', () => {
  it('grammar.md の svc- 用例（std.each によるマッピングの分解と組み立て）が一致する', async () => {
    const body = `
$do:
- $let:
    e: {$std.each: {web: 80, db: 5432}}
- key: svc-\${e.key}
  value: \${e.value}
`;
    const expanded = await run(mappingExpanded(body));
    const builtin = await run(mappingBuiltin(body));
    expect(expanded).toEqual(builtin);
    expect(builtin).toEqual({ 'svc-web': 80, 'svc-db': 5432 });
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
    const expanded = await run(mappingExpanded(body));
    const builtin = await run(mappingBuiltin(body));
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
    await expect(run(mappingExpanded(body))).rejects.toThrow();
    await expect(run(mappingBuiltin(body))).rejects.toThrow();
  });
});

// -----------------------------------------------------------------------------
// 1c. $std.opt の展開（docs/reference/std.opt.md）
// -----------------------------------------------------------------------------

function optExpanded(body: string): string {
  return `
$in:${block(body, 2)}
$with:
  std.fail:
    $fn: _
    $body: null
`;
}

// 打ち切りの定型 {$std.opt: 式, $default: {$std.where: false}} の展開。
function cutExpanded(body: string): string {
  return `
$in:${block(body, 2)}
$with:
  std.fail:
    $fn: _
    $body: {$std.where: false}
`;
}

describe('$std.opt の展開との等価性', () => {
  it('欠落するデータの除外（grammar.md 用例）が打ち切りの定型の展開と一致する', async () => {
    const builtin = await run(`
$std.list:
  $do:
  - $let:
      row:
        $std.each:
        - {date: d1, code: c1}
        - {date: d2}
        - {date: d3, code: c3}
  - date: \${row.date}
    code:
      $std.opt: \${row.code}
      $default: {$std.where: false}
`);
    const expanded = await run(`
$std.list:
  $do:
  - $let:
      row:
        $std.each:
        - {date: d1, code: c1}
        - {date: d2}
        - {date: d3, code: c3}
  - date: \${row.date}
    code:
      $in: \${row.code}
      $with:
        std.fail:
          $fn: _
          $body: {$std.where: false}
`);
    expect(expanded).toEqual(builtin);
    expect(builtin).toEqual([
      { date: 'd1', code: 'c1' },
      { date: 'd3', code: 'c3' },
    ]);
  });

  it('$std.first の中で使った打ち切りの定型も、外側の選択のハンドラまで打ち切りが届く', async () => {
    // row が {} の分岐は $default が std.where:false に翻訳し、$std.opt 自身ではなく
    // 外側（ここでは $std.first）で処理されるので、その分岐が消えて次の候補に進む。
    const builtin = await run(`
$std.first:
  $do:
  - $let:
      row: {$std.each: [{}, {code: c3}]}
  - $std.opt: \${row.code}
    $default: {$std.where: false}
`);
    const expanded = await run(`
$std.first:
  $do:
  - $let:
      row: {$std.each: [{}, {code: c3}]}
  - $in: \${row.code}
    $with:
      std.fail:
        $fn: _
        $body: {$std.where: false}
`);
    expect(expanded).toEqual(builtin);
    expect(builtin).toBe('c3');
  });

  it('失敗しない本体では $std.opt は素通しになる', async () => {
    expect(await run('{$std.opt: 5}')).toBe(5);
    expect(await run(optExpanded('5'))).toBe(5);
    // 打ち切りの定型は $default が std.where を含むので、選択のハンドラ
    // （ここでは $std.list）の内側で素通しを確かめる。
    expect(await run('{$std.list: {$std.opt: 5, $default: {$std.where: false}}}')).toEqual([5]);
    expect(await run(`$std.list:${block(cutExpanded('5'), 2)}`)).toEqual([5]);
  });
});

// -----------------------------------------------------------------------------
// 1d. $std.first の展開（docs/reference/std.first.md の概形を完全にしたもの）
// -----------------------------------------------------------------------------

function firstExpanded(body: string): string {
  return `
$do:
- $let:
    run:
      $in:
        $in:${block(body, 10)}
        $with:
          std.each:
            $fn: xs
            $body:
              $collect: \${xs}
              $with:
                $fn: x
                $body:
                  $if: {$first.taken: null}
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
              - {$first.mark: null}
              - - \${x}
      $with:
        first.taken:
          $fn: _
          $body:
            $fn: t
            $body:
              $do:
              - $let:
                  k:
                    $resume: \${t}
              - $.k: \${t}
        first.mark:
          $fn: _
          $body:
            $fn: t
            $body:
              $do:
              - $let:
                  k:
                    $resume: null
              - $.k: true
        return:
          $fn: x
          $body:
            $fn: t
            $body: \${x}
- $let:
    results: {$.run: false}
- \${results[0]}
`;
}

describe('$std.first の展開との等価性', () => {
  it('grammar.md 参照文書の用例（パラメータ未渡しで info に落ちる）が一致する', async () => {
    const body = `
$do:
- $let:
    v: {$std.each: [{$std.param: log_level, $default: null}, info]}
- $std.where: \${v != null}
- \${v}
`;
    const expanded = await run(firstExpanded(body));
    const builtin = await run(`$std.first:${block(body, 2)}`);
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
    const expanded = await run(firstExpanded(body), { onLog: (v) => expandedLogs.push(v) });
    const builtin = await run(`$std.first:${block(body, 2)}`, { onLog: (v) => builtinLogs.push(v) });
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
    await expect(run(firstExpanded(body))).rejects.toThrow();
    await expect(run(`$std.first:${block(body, 2)}`)).rejects.toThrow();
  });
});

// -----------------------------------------------------------------------------
// 1d2. $std.where の展開（grammar.md「打ち切りの導出形 $std.where」節）
// -----------------------------------------------------------------------------

describe('$std.where の展開との等価性', () => {
  it('ガードが {$if: 条件, $then: null, $else: {$std.each: []}} と一致する', async () => {
    const sugar = await run(`
$std.list:
  $do:
  - $let:
      x: {$std.each: [1, 2, 3, 4]}
  - $std.where: \${x % 2 == 0}
  - \${x}
`);
    const expanded = await run(`
$std.list:
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
    expect(await run('{$std.list: {$std.where: true}}')).toEqual([null]);
    expect(await run('{$std.list: {$if: true, $then: null, $else: {$std.each: []}}}')).toEqual([
      null,
    ]);
  });
});

// -----------------------------------------------------------------------------
// 1e. fold の導出（$collect + $std.state、grammar.md「std の派生ハンドラ」節）
// -----------------------------------------------------------------------------

describe('fold の導出（$collect + $std.state）', () => {
  it('[3, 1, 4, 1, 5] の総和が 14 になる', async () => {
    await expect(
      run(`
$std.state: {acc: 0}
$in:
  $do:
  - $collect: [3, 1, 4, 1, 5]
    $with:
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
// 2. $fn の列（カリー化の導出形、grammar.md「引数名の列と部分適用」節）
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
// 7. $std.lookup の展開（grammar.md「計算したキーの照会 $std.lookup」節）
// -----------------------------------------------------------------------------

/** `{$std.lookup: {in: inFlow, key: keyScalar}}` の展開。inFlow はフロー形式（例: "{a: 1}"）。 */
function lookupExpanded(inFlow: string, keyScalar: string): string {
  return `
$do:
- $let:
    m: ${inFlow}
    k: ${keyScalar}
- $std.first:
    $do:
    - $let:
        e:
          $std.each: \${m}
    - $std.where: \${e.key == k}
    - \${e.value}
`;
}

describe('$std.lookup の展開との等価性', () => {
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

  it('無いキーの失敗は、展開も組み込みも $std.opt の $default で同じ既定値になる', async () => {
    const expanded = await run(`
$std.opt:${block(lookupExpanded('{a: 1}', 'x'), 2)}
$default: fallback
`);
    const builtin = await run(`
$std.opt:
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
// 8. $do の文形の展開（grammar.md「$do の展開規則」）
//   {$do: [{$std.state: 初期値}, 残り...]} ≡ {$std.state: 初期値, $in: {$do: [残り...]}}
//   {$do: [{$with: 節}, 残り...]}          ≡ {$in: {$do: [残り...]}, $with: 節}
// -----------------------------------------------------------------------------

describe('$do の文形の展開との等価性', () => {
  it('$with 文は残りの文を包む $with と一致する（値もログの順序も）', async () => {
    const statement = `
$do:
- $with:
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
$in:
  $do:
  - $std.log: before
  - {$std.fail: boom}
$with:
  std.fail:
    $fn: m
    $body:
      $do:
      - $std.log: 'caught: \${m}'
      - recovered
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

  it('$std.state 文は残りの文を本体に取る完結形と一致する（初期値は文の位置で評価される）', async () => {
    const statement = `
$do:
- $let:
    base: 41
- $std.state:
    n: \${base}
- $let:
    v: {$std.get: n}
- \${v + 1}
`;
    const expanded = `
$do:
- $let:
    base: 41
- $std.state:
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
// 9. $std.merge の展開（grammar.md「マッピングのマージ $std.merge」節）
//   値は後勝ち、キーの位置は初出。a 側は自分のキーをその位置のまま並べ、b に同じキーが
//   在ればその値で差し替える。b 側は a に無いキーだけを後ろに足す。
// -----------------------------------------------------------------------------

describe('$std.merge の展開との等価性', () => {
  it('後勝ち・初出の位置（grammar.md 用例）が展開と一致する（キー順まで）', async () => {
    const expanded = await run(`
$let:
  a: {b: 2, a: 1, keep: base}
  b: {b: 9, c: 3}
$in:
  $std.mapping:
    $do:
    - $let:
        phase:
          $std.each: [0, 1]
        src:
          $if: \${phase == 0}
          $then: \${a}
          $else: \${b}
        e:
          $std.each: \${src}
        fresh:
          $if: \${phase == 0}
          $then: true
          $else:
            $std.opt:
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
          $std.opt:
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
