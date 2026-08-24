/**
 * 静的な作用推論が高階呼び出しをどこまで追えるか。
 * 仕様: docs/grammar.md「作用の推論」「関数」、docs/reference/fn.md。
 */
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { evaluate, type EvaluateOptions } from '../src/eval.js';
import type { Value } from '../src/types.js';

const run = (src: string, options?: EvaluateOptions): Promise<Value> =>
  evaluate(parse(src), options);

describe('追跡できる呼び出し', () => {
  it('マッピングをたどるパスの先の関数を呼ぶ（純粋なら境界は単値のまま）', async () => {
    await expect(
      run(`
$do:
- $let:
    helpers:
      double:
        $fn: x
        $body: \${x * 2}
- {$.helpers.double: 20}
`),
    ).resolves.toBe(40);
  });

  it('添字をたどるパス参照も、$let で名前に束縛すれば呼べて追える', async () => {
    // 添字は $.名前 の経路では書けないので、いったん $let で名前を付けてから呼ぶ
    // （docs/grammar.md「呼び出しと名前空間」）。
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
- $let:
    first: \${steps[0]}
    second: \${steps[1]}
- $.second:
    $.first: 20
`),
    ).resolves.toEqual([40, 41]);
  });

  it('引数のマッピングの中の関数を呼ぶと、その本体の選択が境界の形に効く', async () => {
    // $.arg.step は呼び出し側から渡された関数に解決される（引数伝播）。
    // その本体に $std.each があるので境界は静的にリスト形になり、実行時エラーにならない。
    await expect(
      run(`
$do:
- $let:
    apply:
      $fn: arg
      $body: {$.arg.step: '\${arg.init}'}
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
      $body: {$.arg.step: '\${arg.init}'}
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
      - $fn: x
        $body: {$vault.read: '\${x}'}
      - $fn: x
        $body: plain-\${x}
- $std.log: before
- {$.f: db/pw}
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
- $.helpers.choose: {$std.param: branch}
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
- {$.chosen: 0}
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
- $std.list: {$.chosen: 0}
`,
        { params: { fancy: true } },
      ),
    ).resolves.toEqual([1, 2]);
  });

  it('自己適用は関数値の流れの検査が評価前に拒否する', async () => {
    // 引数として自分自身を渡す形。作用の推論は循環で追跡を諦める（誤った行を作らない）が、
    // 停止性は流れの検査（typecheck.ts）が担い、評価前に静的エラーになる。
    await expect(
      run(`
$do:
- $let:
    selfapp:
      $fn: g
      $body: {$.g: 1}
- $.selfapp: \${selfapp}
`),
    ).rejects.toThrow(/self-application detected: .*\$do\[0\]\.\$let\.selfapp/);
  });
});

describe('事前検証（作用シグネチャ）', () => {
  it('マッピング経由のパス呼び出し（$.helpers.read）で呼ぶ関数の中の登録演算も、評価前に要求される', async () => {
    const logs: Value[] = [];
    const doc = `
$do:
- $let:
    helpers:
      read:
        $fn: key
        $body: {$vault.read: '\${key}'}
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
    a: {$.outer: {op: {$fn: y, $body: {$vault.unregistered: '\${y}'}}}}
`;
    await expect(run(doc, { onLog: (v) => logs.push(v) })).rejects.toThrow(
      /unregistered operation: \$vault\.unregistered/,
    );
    // 評価そのものが始まっていないこと（事前検証で拒否された）。潰れていれば
    // 評価が実際に走ってしまい、$std.log: before が流れた後に実行時エラーになる。
    expect(logs).toEqual([]);
  });
});

describe('$do の文形の作用（$with 文 / $std.state 文）', () => {
  // 標準の作用（std.fail / std.get / std.set / 選択）は境界の既定ハンドラが処理するので、
  // 「消えたこと」は事前検証からは見えない。除去を観測できる経路は
  //   a. 登録の要らない演算になる（節に挙げた登録演算は事前検証を通る）
  //   b. 境界の値の形が単値のままになる（選択を除いたとき）
  // の二つなので、ここではその二つで確かめる。

  it('$with 文の節に挙げた登録演算は、後続の文に現れても事前検証を通る', async () => {
    // 除去が効かなければ vault.read が作用集合に残り、ops 未登録として評価前に拒まれる。
    await expect(
      run(`
$do:
- $with:
    vault.read: {$fn: k, $body: stub}
- {$vault.read: db/password}
`),
    ).resolves.toBe('stub');
  });

  it('$with 文の節が選択を処理すれば、境界は単値のままになる', async () => {
    // 除去が効かなければ境界はリスト形と推論され、値が ['first'] に包まれる。
    await expect(
      run(`
$do:
- $with:
    std.each: {$fn: xs, $body: first}
- {$std.each: [a, b]}
`),
    ).resolves.toBe('first');
  });

  it('文形の文があっても、残りの文の作用は数え落とされない', async () => {
    // 文形は残りの文を本体に取るので、解析は残りへ降りなければならない。
    // 降り損なうと未登録の演算を見逃す。降り損ないは「エラーにならない」向きには倒れず、
    // 実行時に同じ文言で落ちるので、評価が始まっていないこと（ログが流れないこと）で見分ける。
    for (const form of ['$std.state: {n: 0}', '$with: {other.op: {$fn: m, $body: x}}']) {
      const logs: Value[] = [];
      await expect(
        run(
          `
$do:
- ${form}
- $std.log: before
- {$vault.read: db/password}
`,
          { onLog: (v) => logs.push(v) },
        ),
      ).rejects.toThrow(/unregistered operation: \$vault\.read/);
      expect(logs).toEqual([]);
    }
  });

  it('文形が足す作用（節の本体と $std.state の初期値）も数える', async () => {
    // ログの文を先に置く。$std.state の初期値は後続の文より先に評価されるので、
    // 文形を先頭に置くと数え落としても評価開始前に落ちてしまい、事前検証と区別できない。
    for (const form of [
      '$std.state: {n: {$vault.read: seed}}',
      '$with: {other.op: {$fn: m, $body: {$vault.read: seed}}}',
    ]) {
      const logs: Value[] = [];
      await expect(
        run(
          `
$do:
- $std.log: before
- ${form}
- done
`,
          { onLog: (v) => logs.push(v) },
        ),
      ).rejects.toThrow(/unregistered operation: \$vault\.read/);
      expect(logs).toEqual([]);
    }
  });

  it('文の位置の外の $in なし $std.state も、初期値の作用は数える（寛容に通す）', async () => {
    const doc = `
$do:
- $let:
    x: {$std.state: {n: {$vault.read: seed}}}
- \${x}
`;
    // 事前検証が初期値まで降りていること（評価はまだ始まっていない）。
    await expect(run(doc)).rejects.toThrow(/unregistered operation: \$vault\.read/);
    // 演算を登録すれば、解析は通って評価器の位置のエラーに至る。
    await expect(run(doc, { ops: { 'vault.read': () => 0 } })).rejects.toThrow(
      /\$std\.state without \$in is only allowed as a statement of \$do/,
    );
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

  it('呼び出しの結果が外側の呼び出しの引数へ流れる（高階の引数の選択も境界の形に効く）', async () => {
    // 内側の呼び出しの結果（閉包）が外側の引数として追跡され、外側の本体の完成の呼び出しが
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
- $.complete:
    $.mk: 1
`),
    ).resolves.toEqual([1, 99]);
  });
});
