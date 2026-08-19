/**
 * 検証テスト：docs/grammar.md（草案 0.4）が定める std の派生ハンドラ
 * （$std.list / $std.mapping / $std.first / $std.state / $std.opt / $std.prune）の
 * 「$handle と $collect への展開」を文書として書き、同じ本体を組み込みで評価した
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
      $handle:${block(body, 8)}
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
    // 状態のハンドラより「外側」でしか捕まらない（$handle の規則）。
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
$handle:${block(body, 2)}
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
  std.where:
    $fn: b
    $body:
      $if: \${b}
      $then:
        $resume: null
      $else: {}
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
// 1c. $std.opt / $std.prune の展開（docs/reference/std.opt.md, std.prune.md）
// -----------------------------------------------------------------------------

function optExpanded(body: string): string {
  return `
$handle:${block(body, 2)}
$with:
  std.fail:
    $fn: _
    $body: null
`;
}

function pruneExpanded(body: string): string {
  return `
$handle:${block(body, 2)}
$with:
  std.fail:
    $fn: _
    $body: {$std.where: false}
`;
}

describe('$std.opt / $std.prune の展開との等価性', () => {
  it('欠落するデータの剪定（grammar.md 用例）が $std.prune の展開と一致する', async () => {
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
      $std.prune: \${row.code}
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
      $handle: \${row.code}
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

  it('$std.first の中で使った $std.prune も、外側の選択のハンドラまで打ち切りが届く', async () => {
    // row が {} の分岐は std.prune が std.where:false に翻訳し、$handle 自身ではなく
    // 外側（ここでは $std.first）で処理されるので、その分岐が消えて次の候補に進む。
    const builtin = await run(`
$std.first:
  $do:
  - $let:
      row: {$std.each: [{}, {code: c3}]}
  - $std.prune: \${row.code}
`);
    const expanded = await run(`
$std.first:
  $do:
  - $let:
      row: {$std.each: [{}, {code: c3}]}
  - $handle: \${row.code}
    $with:
      std.fail:
        $fn: _
        $body: {$std.where: false}
`);
    expect(expanded).toEqual(builtin);
    expect(builtin).toBe('c3');
  });

  it('失敗しない本体では $std.opt / $std.prune は素通しになる', async () => {
    expect(await run('{$std.opt: 5}')).toBe(5);
    expect(await run(optExpanded('5'))).toBe(5);
    // $std.prune は展開の節の本体が std.where を含むため、出現だけで作用集合に選択が
    // 加わる（grammar.md）。境界の直下で裸に使うと境界がリスト形になるので、
    // 選択のハンドラ（ここでは $std.list）の内側で素通しを確かめる。
    expect(await run('{$std.list: {$std.prune: 5}}')).toEqual([5]);
    expect(await run(`$std.list:${block(pruneExpanded('5'), 2)}`)).toEqual([5]);
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
      $handle:
        $handle:${block(body, 10)}
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
          std.where:
            $fn: b
            $body:
              $if: \${b}
              $then:
                $resume: null
              $else: []
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
