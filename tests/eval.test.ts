import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { evaluate, type EvaluateOptions } from '../src/eval.js';
import { EffectfulYamlError, type Value } from '../src/types.js';

const run = (src: string, options?: EvaluateOptions): Promise<Value> =>
  evaluate(parse(src), options);

describe('値だけの文書', () => {
  it('$ を含まない文書はそれ自身に評価される', async () => {
    await expect(run('greeting: hello')).resolves.toEqual({ greeting: 'hello' });
    await expect(run('[1, 2, {a: b}]')).resolves.toEqual([1, 2, { a: 'b' }]);
  });

  it('$$ は literal な $ になる（値もキーも）', async () => {
    await expect(run('$$do: costs $$5')).resolves.toEqual({ $do: 'costs $5' });
  });
});

describe('$do / $let / $if', () => {
  it('$do は最後の文の値になる（do.md）', async () => {
    const logs: Value[] = [];
    await expect(
      run(
        `
$do:
- $log: starting
- hello, world
`,
        { onLog: (v) => logs.push(v) },
      ),
    ).resolves.toBe('hello, world');
    expect(logs).toEqual(['starting']);
  });

  it('空の $do は null', async () => {
    await expect(run('$do: []')).resolves.toBe(null);
  });

  it('$let は後の束縛から先の束縛を参照できる（let.md）', async () => {
    await expect(
      run(`
$do:
- $let:
    x: 2
    y: \${x + 1}
- \${x * y}
`),
    ).resolves.toBe(6);
  });

  it('$if は片方の分岐だけを評価する（if.md）', async () => {
    await expect(
      run(
        `
tls:
  $if: {$param: use_tls}
  $then: {cert: /etc/ssl/cert.pem}
  $else: null
`,
        { params: { use_tls: false } },
      ),
    ).resolves.toEqual({ tls: null });
  });

  it('$if の条件は真偽値でなければならない', async () => {
    await expect(run('{$if: 1, $then: a, $else: b}')).rejects.toThrow(EffectfulYamlError);
  });
});

describe('選択の基本形（grammar.md 用例）', () => {
  it('末尾が $each なら 18 要素になる', async () => {
    await expect(
      run(`
$do:
- $let:
    x: {$each: [a, b, c]}
    y: {$each: [x, y, z]}
- $each:
  - \${x}
  - \${y}
`),
    ).resolves.toEqual([
      'a', 'x', 'a', 'y', 'a', 'z',
      'b', 'x', 'b', 'y', 'b', 'z',
      'c', 'x', 'c', 'y', 'c', 'z',
    ]);
  });

  it('末尾が literal なリストなら 9 ペアになる', async () => {
    await expect(
      run(`
$do:
- $let:
    x: {$each: [a, b, c]}
    y: {$each: [x, y, z]}
- - \${x}
  - \${y}
`),
    ).resolves.toEqual([
      ['a', 'x'], ['a', 'y'], ['a', 'z'],
      ['b', 'x'], ['b', 'y'], ['b', 'z'],
      ['c', 'x'], ['c', 'y'], ['c', 'z'],
    ]);
  });

  it('$each はマッピングを {key, value} に分解する（each.md）', async () => {
    await expect(
      run(`
$do:
- $let:
    e: {$each: {web: 80, db: 5432}}
- \${e.key}
`),
    ).resolves.toEqual(['web', 'db']);
  });

  it('リストの要素は合成なので、選択は外側のブロック全体を分岐させる', async () => {
    await expect(run('$do: [[1, {$each: [a, b]}]]')).resolves.toEqual([
      [1, 'a'],
      [1, 'b'],
    ]);
  });

  it('演算の引数も合成なので、$each の入れ子が平坦化される', async () => {
    await expect(run('{$each: {$each: [[1, 2], [3, 4]]}}')).resolves.toEqual([1, 2, 3, 4]);
  });

  it('データ文脈では最も外側の $ 式だけが境界になる（$do の中との対比）', async () => {
    // 上の $do のテストでは同じ字面がブロック全体を分岐させる。
    // データ文脈では {$each} 自身が境界なので、そこで収集されてリストになる。
    await expect(run('x: [1, {$each: [a, b]}]')).resolves.toEqual({ x: [1, ['a', 'b']] });
  });

  it('兄弟の境界は作用を共有しない（状態は島ごとに独立）', async () => {
    await expect(
      run('a: {$do: [{$set: {n: 1}}, {$get: n}]}\nb: {$get: n}'),
    ).rejects.toThrow('uninitialized cell: n');
  });
});

describe('$where（where.md）', () => {
  it('内包表記になる', async () => {
    await expect(
      run(`
$do:
- $let:
    x: {$each: [1, 2, 3]}
    y: {$each: [1, 2, 3]}
- $where: \${x < y}
- - \${x}
  - \${y}
`),
    ).resolves.toEqual([
      [1, 2],
      [1, 3],
      [2, 3],
    ]);
  });
});

describe('$param / $default（param.md）', () => {
  it('渡されたパラメータを読み、無ければ $default を使う', async () => {
    await expect(
      run(
        `
host: {$param: db_host}
port: {$param: db_port, $default: 5432}
`,
        { params: { db_host: 'example.com' } },
      ),
    ).resolves.toEqual({ host: 'example.com', port: 5432 });
  });

  it('$default が無く渡されてもいなければエラー', async () => {
    await expect(run('{$param: nope}')).rejects.toThrow(EffectfulYamlError);
  });

  it('$default は遅延位置：パラメータが渡されていれば中の作用は起きない', async () => {
    const logs: Value[] = [];
    await expect(
      run(
        `
port:
  $param: port
  $default:
    $do:
    - $log: defaulted
    - $fail: port is required
`,
        { params: { port: 8080 }, onLog: (v) => logs.push(v) },
      ),
    ).resolves.toEqual({ port: 8080 });
    expect(logs).toEqual([]);
  });

  it('評価されない $default の演算も作用に数える（$if の分岐と同じ出現主義）', async () => {
    // 選択が $default にだけ現れるので境界はリスト形。渡されていれば分岐せず要素 1 になる。
    await expect(
      run('{$param: x, $default: {$each: [1, 2]}}', { params: { x: 5 } }),
    ).resolves.toEqual([5]);
    await expect(run('{$param: x, $default: {$each: [1, 2]}}')).resolves.toEqual([1, 2]);
  });

  it('grammar.md の用例（パラメータと条件分岐）', async () => {
    await expect(
      run(
        `
server:
  host: {$param: db_host}
  port: {$param: db_port, $default: 5432}
  tls:
    $if: {$param: use_tls}
    $then:
      cert: /etc/ssl/cert.pem
    $else: null
`,
        { params: { db_host: 'example.com', use_tls: false } },
      ),
    ).resolves.toEqual({
      server: { host: 'example.com', port: 5432, tls: null },
    });
  });
});

describe('状態（get.md / set.md / state.md）', () => {
  it('$set した値を $get で読む', async () => {
    await expect(
      run(`
$do:
- $set: {n: 41}
- $let:
    v: {$get: n}
- \${v + 1}
`),
    ).resolves.toBe(42);
  });

  it('境界の内側のマッピングの値は合成なので、周囲の状態を見る', async () => {
    await expect(
      run(`
$do:
- $set: {n: 41}
- v: {$get: n}
`),
    ).resolves.toEqual({ v: 41 });
  });

  it('マッピングの値の $get が貫流状態を読む（選択と組み合わせた形）', async () => {
    await expect(
      run(`
$do:
- $set: {n: 0}
- $let:
    name: {$each: [web, db]}
- $let:
    c: {$get: n}
- $set:
    n: \${c + 1}
- name: \${name}
  id: {$get: n}
`),
    ).resolves.toEqual([
      { name: 'web', id: 1 },
      { name: 'db', id: 2 },
    ]);
  });

  it('未作成のセルの読み出しはエラー', async () => {
    await expect(run('{$get: nope}')).rejects.toThrow(EffectfulYamlError);
  });

  it('内側の $state は外の状態に触れない（state.md スコープの隔離）', async () => {
    await expect(
      run(`
$do:
- $set: {n: 100}
- $let:
    inner:
      $state: {n: 0}
      $in:
        $do:
        - $set: {n: 1}
        - {$get: n}
    outer: {$get: n}
- inner: \${inner}
  outer: \${outer}
`),
    ).resolves.toEqual({ inner: 1, outer: 100 });
  });

  it('貫流: 状態が分岐から分岐へ持ち越される', async () => {
    await expect(
      run(`
$state: {n: 0}
$in:
  $list:
    $do:
    - $set: {n: 10}
    - $let:
        x: {$each: [a, b]}
        i: {$get: n}
    - $set:
        n: \${i + 1}
    - \${x}\${i}
`),
    ).resolves.toEqual(['a10', 'b11']);
  });

  it('分岐点で分かれる: 各分岐が選択時点の状態を引き継ぐ', async () => {
    await expect(
      run(`
$list:
  $state: {n: 0}
  $in:
    $do:
    - $set: {n: 10}
    - $let:
        x: {$each: [a, b]}
        i: {$get: n}
    - $set:
        n: \${i + 1}
    - \${x}\${i}
`),
    ).resolves.toEqual(['a10', 'b10']);
  });

  it('分岐ごとに初期化', async () => {
    await expect(
      run(`
$do:
- $let:
    x: {$each: [a, b]}
- $state: {n: 0}
  $in:
    $do:
    - $let:
        i: {$get: n}
    - $set:
        n: \${i + 1}
    - \${x}\${i}
`),
    ).resolves.toEqual(['a0', 'b0']);
  });

  it('連番の採番（既定ハンドラの貫流）', async () => {
    await expect(
      run(`
$do:
- $set: {n: 0}
- $let:
    name: {$each: [web, db, cache]}
    id: {$get: n}
- $set:
    n: \${id + 1}
- name: \${name}
  id: \${id}
`),
    ).resolves.toEqual([
      { name: 'web', id: 0 },
      { name: 'db', id: 1 },
      { name: 'cache', id: 2 },
    ]);
  });
});

describe('$list / $mapping / $first', () => {
  it('$list は全分岐を集める（list.md）', async () => {
    await expect(
      run(`
sizes:
  $list:
    $do:
    - $let:
        n: {$each: [1, 2, 3]}
    - \${n * 10}
`),
    ).resolves.toEqual({ sizes: [10, 20, 30] });
  });

  it('選択が無ければ要素 1 のリストになる', async () => {
    await expect(run('{$list: 42}')).resolves.toEqual([42]);
  });

  it('$mapping は {key, value} を集める（mapping.md）', async () => {
    await expect(
      run(`
$mapping:
  $do:
  - $let:
      e: {$each: {web: 80, db: 5432}}
  - key: svc-\${e.key}
    value: \${e.value}
`),
    ).resolves.toEqual({ 'svc-web': 80, 'svc-db': 5432 });
  });

  it('$first は失敗しなかった最初の分岐（first.md）', async () => {
    await expect(
      run(`
log_level:
  $first:
    $do:
    - $let:
        v: {$each: [{$param: log_level, $default: null}, info]}
    - $where: \${v != null}
    - \${v}
`),
    ).resolves.toEqual({ log_level: 'info' });
  });

  it('$first は渡されたパラメータを優先する', async () => {
    await expect(
      run(
        `
log_level:
  $first:
    $do:
    - $let:
        v: {$each: [{$param: log_level, $default: null}, info]}
    - $where: \${v != null}
    - \${v}
`,
        { params: { log_level: 'debug' } },
      ),
    ).resolves.toEqual({ log_level: 'debug' });
  });

  it('全分岐が打ち切られれば $first は失敗する', async () => {
    await expect(
      run(`
$first:
  $do:
  - $let:
      v: {$each: [1, 2]}
  - $where: false
  - \${v}
`),
    ).rejects.toThrow(EffectfulYamlError);
  });

  it('$list は失敗を処理しない（fail.md）', async () => {
    await expect(run('{$list: {$fail: boom}}')).rejects.toThrow(/boom/);
  });
});

describe('$fn / $op / $pipe', () => {
  it('$fn を $. で呼ぶ（fn.md）', async () => {
    await expect(
      run(`
$do:
- $let:
    double:
      $fn: x
      $body: \${x * 2}
- {$.double: 21}
`),
    ).resolves.toBe(42);
  });

  it('$op で登録演算に短い名前を付ける（op.md）', async () => {
    await expect(
      run(
        `
$do:
- $let:
    read: {$op: vault.secrets.read}
- {$.read: db/password}
`,
        { ops: { 'vault.secrets.read': (k) => `secret(${String(k)})` } },
      ),
    ).resolves.toBe('secret(db/password)');
  });

  it('$pipe は Kleisli 合成（pipe.md）', async () => {
    await expect(
      run(`
$do:
- $let:
    double:
      $fn: x
      $body: \${x * 2}
    succ:
      $fn: x
      $body: \${x + 1}
- $pipe: 20
  $through:
  - \${double}
  - \${succ}
`),
    ).resolves.toBe(41);
  });

  it('空の $through は先頭の値をそのまま返す', async () => {
    await expect(run('{$pipe: 7}')).resolves.toBe(7);
  });

  it('呼び出しの引数は合成なので、引数の選択が呼び出しごと分岐する', async () => {
    await expect(
      run(`
$do:
- $let:
    double:
      $fn: x
      $body: \${x * 2}
- $.double: {$each: [1, 2]}
`),
    ).resolves.toEqual([2, 4]);
  });

  it('閉包は文書の値に残れない', async () => {
    await expect(
      run(`
$fn: x
$body: \${x}
`),
    ).rejects.toThrow(EffectfulYamlError);
  });
});

describe('$handle / $with / $resume（handle.md）', () => {
  it('失敗を捕捉して既定値に置き換える', async () => {
    const logs: Value[] = [];
    await expect(
      run(
        `
port:
  $handle:
    $do:
    - $let:
        p: {$param: port, $default: 0}
    - $if: \${p <= 0}
      $then:
        $fail: invalid port \${p}
      $else: \${p}
  $with:
    fail:
      $fn: msg
      $body:
        $do:
        - $log: \${msg}
        - 5432
`,
        { onLog: (v) => logs.push(v) },
      ),
    ).resolves.toEqual({ port: 5432 });
    expect(logs).toEqual(['invalid port 0']);
  });

  it('ログを計装して外へ転送する', async () => {
    const logs: Value[] = [];
    await expect(
      run(
        `
$handle:
  $do:
  - $log: hello
  - 42
$with:
  log:
    $fn: msg
    $body:
      $do:
      - $log: 'app: \${msg}'
      - {$resume: null}
`,
        { onLog: (v) => logs.push(v) },
      ),
    ).resolves.toBe(42);
    expect(logs).toEqual(['app: hello']);
  });

  it('$resume の多重呼び出しで $list を自作できる', async () => {
    await expect(
      run(`
$handle:
  $do:
  - $let:
      x: {$each: [1, 2]}
      y: {$each: [10, 20]}
  - \${x + y}
$with:
  each:
    $fn: xs
    $body:
      $list:
        $do:
        - $let:
            e:
              $each: \${xs}
            part:
              $resume: \${e}
            r:
              $each: \${part}
        - \${r}
  return:
    $fn: v
    $body:
    - \${v}
`),
    ).resolves.toEqual([11, 21, 12, 22]);
  });

  it('組み込みの $each も同じ結果になる（each.md）', async () => {
    await expect(
      run(`
$do:
- $let:
    x: {$each: [1, 2]}
    y: {$each: [10, 20]}
- \${x + y}
`),
    ).resolves.toEqual([11, 21, 12, 22]);
  });

  it('$resume は節の本体の外では呼べない', async () => {
    await expect(run('{$resume: 1}')).rejects.toThrow(EffectfulYamlError);
  });
});

describe('静的な作用推論', () => {
  it('実行されない分岐の選択も境界の形に算入される', async () => {
    await expect(
      run(
        `
result:
  $if: {$param: cond}
  $then: {$each: [a, b]}
  $else: 42
`,
        { params: { cond: false } },
      ),
    ).resolves.toEqual({ result: [42] });
  });

  it('同じ $if でも境界の内側なら、リストになるのは境界（文書）の側', async () => {
    // $if は最も外側の $ 式ではない（$do の内側）ので境界ではない。
    // 選択はマッピングの値から文書の境界まで合流する。
    await expect(
      run(
        `
$do:
- result:
    $if: {$param: cond}
    $then: {$each: [a, b]}
    $else: 42
`,
        { params: { cond: false } },
      ),
    ).resolves.toEqual([{ result: 42 }]);
  });

  it('選ばれた側が選択でも同じ形になる', async () => {
    await expect(
      run(
        `
result:
  $if: {$param: cond}
  $then: {$each: [a, b]}
  $else: 42
`,
        { params: { cond: true } },
      ),
    ).resolves.toEqual({ result: ['a', 'b'] });
  });

  it('レキシカルな関数の本体の選択も呼び出し位置の形に効く', async () => {
    await expect(
      run(`
$do:
- $let:
    pick:
      $fn: xs
      $body:
        $each: \${xs}
- {$.pick: [1, 2, 3]}
`),
    ).resolves.toEqual([1, 2, 3]);
  });

  it('追跡できない呼び出しの選択では境界をリスト扱いしない（実行時に検出する）', async () => {
    // 引数 arg は $if の分岐で、片方が関数を持たないので構造的に追跡できない
    // （パス参照 ${a.f} 自体は追跡できる。tests/analyzer.test.ts を参照）。
    // 「不明な呼び出しが選択を持つかもしれない」ことを理由に境界をリストにはせず、
    // 実際に分岐したときだけ実行時のエラーにする。
    await expect(
      run(
        `
$do:
- $let:
    apply:
      $fn: a
      $body:
        $pipe: 1
        $through:
        - \${a.f}
    arg:
      $if: {$param: with_choice}
      $then:
        f:
          $fn: x
          $body: {$each: [1, 2]}
      $else: 0
- $.apply: \${arg}
`,
        { params: { with_choice: true } },
      ),
    ).rejects.toThrow(/expected 1 result, got 2[\s\S]*cannot track/);
  });

  it('登録されていない演算は評価前に拒否される', async () => {
    await expect(run('password: {$vault.read: secret/db/password}')).rejects.toThrow(
      /unregistered operation: \$vault\.read/,
    );
  });

  it('登録演算は非同期でもよい', async () => {
    await expect(
      run('password: {$vault.read: secret/db/password}', {
        ops: { 'vault.read': async (k) => `value of ${String(k)}` },
      }),
    ).resolves.toEqual({ password: 'value of secret/db/password' });
  });

  it('$handle が節を与えた演算は登録されていなくてよい', async () => {
    await expect(
      run(`
$handle: {$vault.read: db/password}
$with:
  vault.read:
    $fn: key
    $body: handled-\${key}
`),
    ).resolves.toBe('handled-db/password');
  });
});

describe('fold（$state + $list + $pipe による畳み込み）', () => {
  it('6 になる', async () => {
    await expect(
      run(`
$do:
- $let:
    fold:
      $fn: arg
      $body:
        $state:
          acc: \${arg.init}
        $in:
          $do:
          - $list:
              $do:
              - $let:
                  x:
                    $each: \${arg.list}
                  a: {$get: acc}
                  b:
                    $pipe:
                      acc: \${a}
                      x: \${x}
                    $through:
                    - \${arg.step}
              - $set:
                  acc: \${b}
          - {$get: acc}
- $.fold:
    init: 0
    list: [1, 2, 3]
    step:
      $fn: s
      $body: \${s.acc + s.x}
`),
    ).resolves.toBe(6);
  });
});

describe('作用の推論の計算量', () => {
  it('$let + $fn の深い入れ子でも走査は線形で終わる', async () => {
    // かつて $fn の定義ごとに本体を二重走査していたため 2^深さ に爆発した。回帰を防ぐ。
    let body: unknown = '${x}';
    for (let i = 0; i < 32; i++) {
      body = { $do: [{ $let: { f: { $fn: 'x', $body: body } } }, { '$.f': i }] };
    }
    await expect(evaluate(body)).resolves.toBe(0);
  });
});
