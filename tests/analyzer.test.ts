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
    // 2 段目の本体の $std.each は、添字のパス参照を追えたときだけ境界の形に効く
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
        $std.each:
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
    // その本体に $std.each があるので境界は静的にリスト形になり、実行時エラーにならない。
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
        $std.each:
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

  it('リテラルのリストからの $std.each で選んだ関数も追える（分岐の合併）', async () => {
    // $std.each 自身の選択は境界の形を見ても判別できないので、事前検証で確かめる。
    // 合併の一方に登録演算があることは、$std.each の要素をたどれたときだけ分かる。
    // 未登録の演算は実行時にも同じ文言で拒まれるため、$std.log が流れたかどうかで
    // 「評価前に拒否された」ことを見分ける。
    const logs: Value[] = [];
    const doc = `
$do:
- $let:
    f:
      $std.each:
      - {$op: vault.read}
      - $fn: x
        $body: plain-\${x}
- $std.log: before
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
    // 関数の本体の $if は合成なので、選ばれない $then の $std.each も作用に数える。
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
          $then: {$std.each: [a, b]}
          $else: single
- $pipe: {$std.param: branch}
  $through:
  - \${helpers.choose}
`,
        { params: { branch: false } },
      ),
    ).resolves.toEqual(['single']);
  });

  it('マッピング経由のパス呼び出し（$.fns.choose）でも $std.each の境界がリスト形に決まる', async () => {
    // $. の呼び出しがパスを取れるのは fns.choose のように束縛の先のマッピングをたどる形。
    // 先頭区画 fns を senv から引いた後、残りの区画 choose を追跡木の field() でたどれて
    // 初めて閉包の本体が解析され、$std.each が境界の形をリストに決める。
    // たどれなければ実行時に「expected 1 result」で落ちるので、
    // 結果がちゃんと 3 要素のリストになることが、パスの追跡が効いている証拠になる。
    await expect(
      run(`
$do:
- $let:
    fns:
      choose:
        $fn: x
        $body:
          $std.each: [a, b, c]
- {$.fns.choose: ignored}
`),
    ).resolves.toEqual(['a', 'b', 'c']);
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
      $if: {$std.param: fancy}
      $then:
        $fn: x
        $body: {$std.each: [1, 2]}
      $else: 0
- $pipe: 0
  $through:
  - \${chosen}
`;
    await expect(run(doc, { params: { fancy: true } })).rejects.toThrow(
      /expected 1 result, got 2/,
    );
    // 回避策は明示のハンドラで形を宣言すること、とエラーが案内する。
    await expect(run(doc, { params: { fancy: true } })).rejects.toThrow(/\$std.list/);
  });

  it('案内どおり $std.list で包めば形が明示になり、実行時エラーにならない', async () => {
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
- $std.list:
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
- $std.log: before
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

  it('マッピング経由のパス呼び出し（$.helpers.read）で呼ぶ関数の中の登録演算も、評価前に要求される', async () => {
    const logs: Value[] = [];
    const doc = `
$do:
- $let:
    helpers:
      read: {$op: vault.read}
- $std.log: before
- {$.helpers.read: db/password}
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

  it('同じ $fn を違う束縛の中身で 2 回捕まえても、閉包の正準形が別の鍵になる', async () => {
    // refsOf(t.body) はパス呼び出し `$.h.op` が実際に読む束縛名（先頭区画 h）だけを
    // 閉包の正準形の鍵に入れなければならない。パス全体（h.op）を鍵に入れると、
    // senv には "h.op" というキーは無いので参照は常に外れ（canon(undefined) = 定数 -1）、
    // h の中身が違っても同じ鍵になってしまう。
    // ここでは同じ $fn ノード（inner）を、h が「登録演算」の場合と「純粋な恒等関数」の場合の
    // 2 通りの環境で捕まえ、先に解析される側（b、作用なし）のメモが後の側（a、未登録演算）を
    // 誤って上書きしないことを確かめる。誤って潰れれば a の未登録演算が見逃され、
    // 評価前の事前検証をすり抜けて実行時まで進んでしまう（$std.log: before が先に流れる）。
    const logs: Value[] = [];
    const doc = `
$do:
- $let:
    outer:
      $fn: h
      $body:
        $do:
        - $let:
            inner:
              $fn: x
              $body: {$.h.op: '\${x}'}
        - {$.inner: 1}
- $std.log: before
- $let:
    b: {$.outer: {op: {$fn: y, $body: '\${y}'}}}
- $let:
    a: {$.outer: {op: {$op: vault.unregistered}}}
`;
    await expect(run(doc, { onLog: (v) => logs.push(v) })).rejects.toThrow(
      /unregistered operation: \$vault\.unregistered/,
    );
    // 評価そのものが始まっていないこと（事前検証で拒否された）。潰れていれば
    // 評価が実際に走ってしまい、$std.log: before が流れた後に実行時エラーになる。
    expect(logs).toEqual([]);
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

describe('呼び出しの結果の追跡（部分適用）', () => {
  it('部分適用を完成させる呼び出しの選択が境界の形に効く（明示のハンドラなしでリスト）', async () => {
    // p1 は呼び出しの結果（部分適用が返した閉包）。結果を追跡できなければ
    // 完成の呼び出しの $std.each が算入されず、境界は単値と推論されて実行時エラーになる。
    await expect(
      run(`
$do:
- $let:
    pick:
      $fn: [a, b]
      $body:
        $std.each:
        - ${'$'}{a}
        - ${'$'}{b}
- $let:
    p1: {$.pick: 10}
- {$.p1: 20}
`),
    ).resolves.toEqual([10, 20]);
  });

  it('部分適用の先の未登録演算は、実行されない分岐でも評価前に拒否される', async () => {
    // 実行される経路は $then 側だけなので、実行時エラーでは検出できない。
    // 拒否されるのは、呼び出しの結果の追跡が $else 側の完成の呼び出しへ届く証拠である。
    await expect(
      run(`
$do:
- $let:
    f:
      $fn: [a, b]
      $body:
        $nope.op: ${'$'}{a}
- $let:
    g: {$.f: 1}
- $if: true
  $then: safe
  $else: {$.g: 2}
`),
    ).rejects.toThrow('unregistered operation: $nope.op');
  });

  it('$pipe の段の結果が次の段の引数へ流れる（高階の段の選択も境界の形に効く）', async () => {
    // 1 段目の結果（閉包）が 2 段目の引数として追跡され、2 段目の本体の完成の呼び出しが
    // $std.each を算入する。追跡が切れると境界は単値と推論され、実行時エラーになる。
    await expect(
      run(`
$do:
- $let:
    mk:
      $fn: [a, b]
      $body:
        $std.each:
        - ${'$'}{a}
        - ${'$'}{b}
    complete:
      $fn: g
      $body: {$.g: 99}
- $pipe: 1
  $through:
  - ${'$'}{mk}
  - ${'$'}{complete}
`),
    ).resolves.toEqual([1, 99]);
  });
});
