/**
 * 静的な作用推論が高階呼び出しをどこまで追えるか。
 * 仕様: docs/grammar.md「作用の推論」「関数」、docs/reference/pipe.md。
 */
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { evaluate, type EvaluateOptions } from '../src/eval.js';
import type { Value } from '../src/types.js';

const run = (src: string, options?: EvaluateOptions): Promise<Value> =>
  evaluate(parse(src), options);

describe('追跡できる呼び出し', () => {
  it('パス参照の段の関数を呼ぶ（純粋なら境界は単値のまま）', async () => {
    await expect(
      run(`
$do:
- $let:
    helpers:
      double:
        $fn: x
        $body: \${x * 2}
- $pipe: 20
  $through:
  - \${helpers.double}
`),
    ).resolves.toBe(40);
  });

  it('リストの添字をたどるパス参照も追える', async () => {
    // 2 段目の本体の $each は、添字のパス参照を追えたときだけ境界の形に効く
    // （追えなければ境界は単値と推論され、分岐 2 本で実行時エラーになる）。
    await expect(
      run(`
$do:
- $let:
    steps:
    - $fn: x
      $body: \${x * 2}
    - $fn: x
      $body:
        $each:
        - \${x}
        - \${x + 1}
- $pipe: 20
  $through:
  - \${steps[0]}
  - \${steps[1]}
`),
    ).resolves.toEqual([40, 41]);
  });

  it('引数のマッピングの中の関数を段に置くと、その本体の選択が境界の形に効く', async () => {
    // ${arg.step} は呼び出し側から渡された関数に解決される（引数伝播）。
    // その本体に $each があるので境界は静的にリスト形になり、実行時エラーにならない。
    await expect(
      run(`
$do:
- $let:
    apply:
      $fn: arg
      $body:
        $pipe: \${arg.init}
        $through:
        - \${arg.step}
- $.apply:
    init: 10
    step:
      $fn: x
      $body:
        $each:
        - \${x}
        - \${x + 1}
`),
    ).resolves.toEqual([10, 11]);
  });

  it('同じ関数でも渡す関数値ごとに解析し直す（多相的解析）', async () => {
    // 純粋な step を渡した呼び出しは単値のまま。
    await expect(
      run(`
$do:
- $let:
    apply:
      $fn: arg
      $body:
        $pipe: \${arg.init}
        $through:
        - \${arg.step}
- $.apply:
    init: 10
    step:
      $fn: x
      $body: \${x + 1}
`),
    ).resolves.toBe(11);
  });

  it('リテラルのリストからの $each で選んだ関数も追える（分岐の合併）', async () => {
    // $each 自身の選択は境界の形を見ても判別できないので、事前検証で確かめる。
    // 合併の一方に登録演算があることは、$each の要素をたどれたときだけ分かる。
    // 未登録の演算は実行時にも同じ文言で拒まれるため、$log が流れたかどうかで
    // 「評価前に拒否された」ことを見分ける。
    const logs: Value[] = [];
    const doc = `
$do:
- $let:
    f:
      $each:
      - {$op: vault.read}
      - $fn: x
        $body: plain-\${x}
- $log: before
- $pipe: db/pw
  $through:
  - \${f}
`;
    await expect(run(doc, { onLog: (v) => logs.push(v) })).rejects.toThrow(
      /unregistered operation: \$vault\.read/,
    );
    expect(logs).toEqual([]);

    await expect(
      run(doc, {
        ops: { 'vault.read': (k) => `secret(${String(k)})` },
        onLog: (v) => logs.push(v),
      }),
    ).resolves.toEqual(['secret(db/pw)', 'plain-db/pw']);
  });
});

describe('出現主義（追跡が効くと形が変わる）', () => {
  it('実行時の分岐が 1 本でも、追跡できる呼び出しの選択は要素 1 のリストになる', async () => {
    // 関数の本体の $if は合成なので、選ばれない $then の $each も作用に数える。
    // 実行時は $else 側だけを通るが、境界の形は静的な作用集合が決める。
    await expect(
      run(
        `
$do:
- $let:
    helpers:
      choose:
        $fn: flag
        $body:
          $if: \${flag}
          $then: {$each: [a, b]}
          $else: single
- $pipe: {$param: branch}
  $through:
  - \${helpers.choose}
`,
        { params: { branch: false } },
      ),
    ).resolves.toEqual(['single']);
  });
});

describe('追跡できない呼び出し', () => {
  it('関数値と関数でない値に分岐する $if は追跡できず、選択は実行時のエラーになる', async () => {
    // $if の片方が関数値でないので、両分岐の合併としては追跡できない
    // （追跡できない値の呼び出しは行を作らないので、境界は単値と推論される）。
    const doc = `
$do:
- $let:
    chosen:
      $if: {$param: fancy}
      $then:
        $fn: x
        $body: {$each: [1, 2]}
      $else: 0
- $pipe: 0
  $through:
  - \${chosen}
`;
    await expect(run(doc, { params: { fancy: true } })).rejects.toThrow(
      /expected 1 result, got 2/,
    );
    // 回避策は明示のハンドラで形を宣言すること、とエラーが案内する。
    await expect(run(doc, { params: { fancy: true } })).rejects.toThrow(/\$list/);
  });

  it('案内どおり $list で包めば形が明示になり、実行時エラーにならない', async () => {
    await expect(
      run(
        `
$do:
- $let:
    chosen:
      $if: {$param: fancy}
      $then:
        $fn: x
        $body: {$each: [1, 2]}
      $else: 0
- $list:
    $pipe: 0
    $through:
    - \${chosen}
`,
        { params: { fancy: true } },
      ),
    ).resolves.toEqual([1, 2]);
  });

  it('自己適用は追跡不能に倒す（解析が止まる）', async () => {
    // 引数として自分自身を渡す形。解析が循環するので追跡を諦める（誤った行を作らない）。
    await expect(
      run(`
$do:
- $let:
    selfapp:
      $fn: g
      $body:
        $pipe: 1
        $through:
        - \${g}
- $.selfapp: \${selfapp}
`),
    ).rejects.toThrow(/is not a function|expected 1 result/);
  });
});

describe('事前検証（作用シグネチャ）', () => {
  it('パス経由で呼ぶ関数の中の登録演算も、評価前に要求される', async () => {
    const logs: Value[] = [];
    const doc = `
$do:
- $let:
    helpers:
      read: {$op: vault.read}
- $log: before
- $pipe: db/password
  $through:
  - \${helpers.read}
`;
    await expect(run(doc, { onLog: (v) => logs.push(v) })).rejects.toThrow(
      /unregistered operation: \$vault\.read/,
    );
    // 評価そのものが始まっていないこと（事前検証で拒否された）。
    expect(logs).toEqual([]);

    await expect(
      run(doc, {
        ops: { 'vault.read': (k) => `secret(${String(k)})` },
        onLog: (v) => logs.push(v),
      }),
    ).resolves.toBe('secret(db/password)');
    expect(logs).toEqual(['before']);
  });
});

describe('作用の推論の計算量', () => {
  it('1 段に呼び出しが複数あっても、引数伝播で走査が爆発しない', async () => {
    // 引数伝播は呼び出し位置ごとに本体を解析し直すので、メモが無いと 2^深さ に爆発する。
    // 引数の追跡木が同じ（関数を含まないデータ）なら、走査はメモで 1 回に畳まれる。
    // $if の両分岐を数えるのは解析だけで、評価は片方しか通らない（評価側は深さに線形）。
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
  });

  it(
    '引数にインラインの関数を渡す呼び出しが 1 段に複数あっても爆発しない',
    async () => {
      // 引数の追跡木は呼び出しのたびに作り直されるので、木の同一性で引くメモは当たらない。
      // それだと深さ 18・分岐 2 で 2^18 回の走査になる（手元で 2.8 秒、深さ 20 で 10.7 秒）。
      // 正準形で引けば、構造的に同じ (閉包, 引数) の対は 1 度しか本体を解析しない。
      // 引数の二つの $fn は同じ形だが別のノードである（YAML に二度書けばそうなる）。
      let body: unknown = 'leaf';
      for (let i = 0; i < 18; i++) {
        const arg = (): unknown => ({ $fn: 'y', $body: 'leaf' });
        body = {
          $do: [
            { $let: { f: { $fn: 'x', $body: body } } },
            { $if: false, $then: { '$.f': arg() }, $else: { '$.f': arg() } },
          ],
        };
      }
      await expect(evaluate(body)).resolves.toBe('leaf');
    },
    1000,
  );
});
