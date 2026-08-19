import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { evaluate, type EvaluateOptions } from '../src/eval.js';
import { EffectfulYamlError, OperationFailure, type Value } from '../src/types.js';

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
  it('$do は最後の文の値になる', async () => {
    const logs: Value[] = [];
    await expect(
      run(
        `
$do:
- $std.log: starting
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

  it('$let は後の束縛から先の束縛を参照できる', async () => {
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

  it('$if は片方の分岐だけを評価する', async () => {
    await expect(
      run(
        `
tls:
  $if: {$std.param: use_tls}
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
  it('末尾が $std.each なら 18 要素になる', async () => {
    await expect(
      run(`
$do:
- $let:
    x: {$std.each: [a, b, c]}
    y: {$std.each: [x, y, z]}
- $std.each:
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
    x: {$std.each: [a, b, c]}
    y: {$std.each: [x, y, z]}
- - \${x}
  - \${y}
`),
    ).resolves.toEqual([
      ['a', 'x'], ['a', 'y'], ['a', 'z'],
      ['b', 'x'], ['b', 'y'], ['b', 'z'],
      ['c', 'x'], ['c', 'y'], ['c', 'z'],
    ]);
  });

  it('$std.each はマッピングを {key, value} に分解する', async () => {
    await expect(
      run(`
$do:
- $let:
    e: {$std.each: {web: 80, db: 5432}}
- \${e.key}
`),
    ).resolves.toEqual(['web', 'db']);
  });

  it('リストの要素は合成なので、選択は外側のブロック全体を分岐させる', async () => {
    await expect(run('$do: [[1, {$std.each: [a, b]}]]')).resolves.toEqual([
      [1, 'a'],
      [1, 'b'],
    ]);
  });

  it('演算の引数も合成なので、$std.each の入れ子が平坦化される', async () => {
    await expect(run('{$std.each: {$std.each: [[1, 2], [3, 4]]}}')).resolves.toEqual([1, 2, 3, 4]);
  });

  it('データ文脈では最も外側の $ 式だけが境界になる（$do の中との対比）', async () => {
    // 上の $do のテストでは同じ字面がブロック全体を分岐させる。
    // データ文脈では {$std.each} 自身が境界なので、そこで収集されてリストになる。
    await expect(run('x: [1, {$std.each: [a, b]}]')).resolves.toEqual({ x: [1, ['a', 'b']] });
  });

  it('兄弟の境界は作用を共有しない（状態は島ごとに独立）', async () => {
    await expect(
      run('a: {$do: [{$std.set: {n: 1}}, {$std.get: n}]}\nb: {$std.get: n}'),
    ).rejects.toThrow('uninitialized cell: n');
  });
});

describe('$std.where', () => {
  it('内包表記になる', async () => {
    await expect(
      run(`
$do:
- $let:
    x: {$std.each: [1, 2, 3]}
    y: {$std.each: [1, 2, 3]}
- $std.where: \${x < y}
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

describe('$std.param / $default', () => {
  it('渡されたパラメータを読み、無ければ $default を使う', async () => {
    await expect(
      run(
        `
host: {$std.param: db_host}
port: {$std.param: db_port, $default: 5432}
`,
        { params: { db_host: 'example.com' } },
      ),
    ).resolves.toEqual({ host: 'example.com', port: 5432 });
  });

  it('$default が無く渡されてもいなければ std.fail が境界まで伝播する', async () => {
    await expect(run('{$std.param: nope}')).rejects.toThrow('failure: parameter not provided: nope');
  });

  it('未渡しの std.fail は呼び出し位置で起きるので、その場で捕捉できる', async () => {
    // 失敗が既定ハンドラ（境界）で起きるのだと、呼び出し位置を包む $handle はもう戻っている。
    // $default の展開が成り立つには、失敗が呼び出し位置で生じなければならない。
    await expect(
      run(`
$handle: {$std.param: nope}
$with:
  std.fail:
    $fn: msg
    $body: caught \${msg}
`),
    ).resolves.toBe('caught parameter not provided: nope');
    await expect(run('{$std.opt: {$std.param: nope}}')).resolves.toBe(null);
  });

  it('{$std.param: 名前, $default: 式} は std.fail 節への展開と等価である', async () => {
    // 展開: {$std.param: 名前} を $handle で包み、std.fail の節で $default の式を返す。
    const expanded = `
$handle: {$std.param: port}
$with:
  std.fail:
    $fn: _
    $body: 5432
`;
    const paramSets: Record<string, Value>[] = [{}, { port: 8080 }];
    for (const params of paramSets) {
      const sugar = await run('{$std.param: port, $default: 5432}', { params });
      await expect(run(expanded, { params })).resolves.toEqual(sugar);
    }
    await expect(run('{$std.param: port, $default: 5432}')).resolves.toBe(5432);
  });

  it('$default は遅延位置：パラメータが渡されていれば中の作用は起きない', async () => {
    const logs: Value[] = [];
    await expect(
      run(
        `
port:
  $std.param: port
  $default:
    $do:
    - $std.log: defaulted
    - $std.fail: port is required
`,
        { params: { port: 8080 }, onLog: (v) => logs.push(v) },
      ),
    ).resolves.toEqual({ port: 8080 });
    expect(logs).toEqual([]);
  });

  it('評価されない $default の演算も作用に数える（$if の分岐と同じ出現主義）', async () => {
    // 選択が $default にだけ現れるので境界はリスト形。渡されていれば分岐せず要素 1 になる。
    await expect(
      run('{$std.param: x, $default: {$std.each: [1, 2]}}', { params: { x: 5 } }),
    ).resolves.toEqual([5]);
    await expect(run('{$std.param: x, $default: {$std.each: [1, 2]}}')).resolves.toEqual([1, 2]);
  });

  it('grammar.md の用例（パラメータと条件分岐）', async () => {
    await expect(
      run(
        `
server:
  host: {$std.param: db_host}
  port: {$std.param: db_port, $default: 5432}
  tls:
    $if: {$std.param: use_tls}
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

describe('状態（$std.get / $std.set / $std.state）', () => {
  it('$std.set した値を $std.get で読む', async () => {
    await expect(
      run(`
$do:
- $std.set: {n: 41}
- $let:
    v: {$std.get: n}
- \${v + 1}
`),
    ).resolves.toBe(42);
  });

  it('境界の内側のマッピングの値は合成なので、周囲の状態を見る', async () => {
    await expect(
      run(`
$do:
- $std.set: {n: 41}
- v: {$std.get: n}
`),
    ).resolves.toEqual({ v: 41 });
  });

  it('マッピングの値の $std.get が貫流状態を読む（選択と組み合わせた形）', async () => {
    await expect(
      run(`
$do:
- $std.set: {n: 0}
- $let:
    name: {$std.each: [web, db]}
- $let:
    c: {$std.get: n}
- $std.set:
    n: \${c + 1}
- name: \${name}
  id: {$std.get: n}
`),
    ).resolves.toEqual([
      { name: 'web', id: 1 },
      { name: 'db', id: 2 },
    ]);
  });

  it('未作成のセルの読み出しは std.fail を起こす', async () => {
    await expect(run('{$std.get: nope}')).rejects.toThrow('failure: uninitialized cell: nope');
  });

  it('未作成のセルの失敗は、状態のハンドラより外側で捕まえられる', async () => {
    // 仕様の展開では、この失敗は $std.state の節の本体（`${hits[0]}`）が起こす。
    // 節の本体の作用はそのハンドラ自身ではなく外側で処理される（$handle の規則）ので、
    // 捕まえられるのは $std.state を包む側だけである。
    await expect(
      run(`
$std.opt:
  $std.state: {}
  $in: {$std.get: nope}
`),
    ).resolves.toBe(null);
    // 内側に置いた $std.opt は、状態のハンドラより内側なので捕まえられない。
    await expect(
      run(`
$std.state: {}
$in:
  $std.opt: {$std.get: nope}
`),
    ).rejects.toThrow('failure: uninitialized cell: nope');
  });

  it('内側の $std.state は外の状態に触れない（スコープの隔離）', async () => {
    await expect(
      run(`
$do:
- $std.set: {n: 100}
- $let:
    inner:
      $std.state: {n: 0}
      $in:
        $do:
        - $std.set: {n: 1}
        - {$std.get: n}
    outer: {$std.get: n}
- inner: \${inner}
  outer: \${outer}
`),
    ).resolves.toEqual({ inner: 1, outer: 100 });
  });

  it('貫流: 状態が分岐から分岐へ持ち越される', async () => {
    await expect(
      run(`
$std.state: {n: 0}
$in:
  $std.list:
    $do:
    - $std.set: {n: 10}
    - $let:
        x: {$std.each: [a, b]}
        i: {$std.get: n}
    - $std.set:
        n: \${i + 1}
    - \${x}\${i}
`),
    ).resolves.toEqual(['a10', 'b11']);
  });

  it('分岐点で分かれる: 各分岐が選択時点の状態を引き継ぐ', async () => {
    await expect(
      run(`
$std.list:
  $std.state: {n: 0}
  $in:
    $do:
    - $std.set: {n: 10}
    - $let:
        x: {$std.each: [a, b]}
        i: {$std.get: n}
    - $std.set:
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
    x: {$std.each: [a, b]}
- $std.state: {n: 0}
  $in:
    $do:
    - $let:
        i: {$std.get: n}
    - $std.set:
        n: \${i + 1}
    - \${x}\${i}
`),
    ).resolves.toEqual(['a0', 'b0']);
  });

  it('連番の採番（既定ハンドラの貫流）', async () => {
    await expect(
      run(`
$do:
- $std.set: {n: 0}
- $let:
    name: {$std.each: [web, db, cache]}
    id: {$std.get: n}
- $std.set:
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

describe('$std.list / $std.mapping / $std.first', () => {
  it('$std.list は全分岐を集める', async () => {
    await expect(
      run(`
sizes:
  $std.list:
    $do:
    - $let:
        n: {$std.each: [1, 2, 3]}
    - \${n * 10}
`),
    ).resolves.toEqual({ sizes: [10, 20, 30] });
  });

  it('選択が無ければ要素 1 のリストになる', async () => {
    await expect(run('{$std.list: 42}')).resolves.toEqual([42]);
  });

  it('$std.mapping は {key, value} を集める', async () => {
    await expect(
      run(`
$std.mapping:
  $do:
  - $let:
      e: {$std.each: {web: 80, db: 5432}}
  - key: svc-\${e.key}
    value: \${e.value}
`),
    ).resolves.toEqual({ 'svc-web': 80, 'svc-db': 5432 });
  });

  it('$std.first は失敗しなかった最初の分岐', async () => {
    await expect(
      run(`
log_level:
  $std.first:
    $do:
    - $let:
        v: {$std.each: [{$std.param: log_level, $default: null}, info]}
    - $std.where: \${v != null}
    - \${v}
`),
    ).resolves.toEqual({ log_level: 'info' });
  });

  it('$std.first は渡されたパラメータを優先する', async () => {
    await expect(
      run(
        `
log_level:
  $std.first:
    $do:
    - $let:
        v: {$std.each: [{$std.param: log_level, $default: null}, info]}
    - $std.where: \${v != null}
    - \${v}
`,
        { params: { log_level: 'debug' } },
      ),
    ).resolves.toEqual({ log_level: 'debug' });
  });

  it('全分岐が打ち切られれば $std.first は失敗する', async () => {
    await expect(
      run(`
$std.first:
  $do:
  - $let:
      v: {$std.each: [1, 2]}
  - $std.where: false
  - \${v}
`),
    ).rejects.toThrow(EffectfulYamlError);
  });

  it('$std.list は失敗を処理しない', async () => {
    await expect(run('{$std.list: {$std.fail: boom}}')).rejects.toThrow(/boom/);
  });
});

describe('$fn / $op / $pipe', () => {
  it('$fn を $. で呼ぶ', async () => {
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

  it('$op で登録演算に短い名前を付ける', async () => {
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

  it('$pipe は Kleisli 合成', async () => {
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
- $.double: {$std.each: [1, 2]}
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

describe('$fn の列と部分適用', () => {
  it('全引数を順に与えれば本体が走る', async () => {
    await expect(
      run(`
$do:
- $let:
    conc:
      $fn: [a, b, c]
      $body: \${a}\${b}\${c}
    ab: {$.conc: a}
    abc: {$.ab: b}
- {$.abc: c}
`),
    ).resolves.toBe('abc');
  });

  it('部分適用の閉包は $collect の $with にも置ける', async () => {
    await expect(
      run(`
$do:
- $let:
    scaled:
      $fn: [k, x]
      $body:
      - \${k * x}
    tripled: {$.scaled: 3}
- $collect: [1, 2, 3]
  $with: \${tripled}
`),
    ).resolves.toEqual([3, 6, 9]);
  });

  it('長さ 1 の列は名前一つと同じ', async () => {
    await expect(
      run(`
$do:
- $let:
    double:
      $fn: [x]
      $body: \${x * 2}
- {$.double: 21}
`),
    ).resolves.toBe(42);
  });

  it('空の列は形の誤り', async () => {
    await expect(run('{$fn: [], $body: 1}')).rejects.toThrow(/\$fn parameter/);
  });

  it('名前の重複は形の誤り', async () => {
    await expect(run('{$fn: [a, a], $body: 1}')).rejects.toThrow(/duplicate \$fn parameter/);
  });

  it('文字列でない要素は形の誤り', async () => {
    await expect(run('{$fn: [a, 1], $body: 2}')).rejects.toThrow(/\$fn parameter/);
  });

  it('実行されない分岐の形の誤りも検査される（出現主義）', async () => {
    await expect(
      run(`
$if: true
$then: safe
$else: {$fn: [], $body: 1}
`),
    ).rejects.toThrow(/\$fn parameter/);
  });

  it('引数が足りないまま文書の値に残れば脱出のエラー', async () => {
    await expect(
      run(`
$do:
- $let:
    add:
      $fn: [a, b]
      $body: \${a + b}
- {$.add: 1}
`),
    ).rejects.toThrow(/cannot escape/);
  });

  it('$handle の節は一引数で呼ばれるので、多引数の節は閉包が値になり脱出のエラーに至る', async () => {
    await expect(
      run(`
$handle: {$std.fail: boom}
$with:
  std.fail:
    $fn: [msg, extra]
    $body: \${msg}
`),
    ).rejects.toThrow(/cannot escape/);
  });
});

describe('$. のパス呼び出し', () => {
  it('2 区画：マッピングに入れた閉包を呼ぶ', async () => {
    await expect(
      run(`
$do:
- $let:
    helpers:
      double:
        $fn: x
        $body: \${x * 2}
- {$.helpers.double: 21}
`),
    ).resolves.toBe(42);
  });

  it('3 区画：入れ子のマッピングをたどって呼ぶ', async () => {
    await expect(
      run(`
$do:
- $let:
    a:
      b:
        c:
          $fn: x
          $body: \${x + 1}
- {$.a.b.c: 41}
`),
    ).resolves.toBe(42);
  });

  it('$op で作った演算参照をマッピング経由で呼ぶ', async () => {
    await expect(
      run(
        `
$do:
- $let:
    helpers:
      read: {$op: vault.secrets.read}
- {$.helpers.read: db/password}
`,
        { ops: { 'vault.secrets.read': (k) => `secret(${String(k)})` } },
      ),
    ).resolves.toBe('secret(db/password)');
  });

  it('先頭区画の束縛が無ければ undefined reference', async () => {
    await expect(run('{$.a.self: 1}')).rejects.toThrow(/undefined reference: a/);
  });

  it('途中の区画が非マッピングなら cannot access key', async () => {
    await expect(
      run(`
$do:
- $let:
    a: 1
- {$.a.self: 1}
`),
    ).rejects.toThrow(/cannot access key '\.self' of a non-mapping value/);
  });

  it('途中の区画にキーが無ければ missing key', async () => {
    await expect(
      run(`
$do:
- $let:
    a: {}
- {$.a.self: 1}
`),
    ).rejects.toThrow(/missing key 'self'/);
  });

  it('たどり着いた値が関数でなければ is not a function（パス全体の名前で）', async () => {
    await expect(
      run(`
$do:
- $let:
    a:
      self: 1
- {$.a.self: 1}
`),
    ).rejects.toThrow(/a\.self is not a function/);
  });

  it('空区画・添字は invalid lexical call name（広げた正規表現が過大に許さないこと）', async () => {
    await expect(run('$..a: 1')).rejects.toThrow(/invalid lexical call name/);
    await expect(run('$.a.: 1')).rejects.toThrow(/invalid lexical call name/);
    await expect(run('$.a[0]: 1')).rejects.toThrow(/invalid lexical call name/);
  });
});

describe('$handle / $with / $resume', () => {
  it('失敗を捕捉して既定値に置き換える', async () => {
    const logs: Value[] = [];
    await expect(
      run(
        `
port:
  $handle:
    $do:
    - $let:
        p: {$std.param: port, $default: 0}
    - $if: \${p <= 0}
      $then:
        $std.fail: invalid port \${p}
      $else: \${p}
  $with:
    std.fail:
      $fn: msg
      $body:
        $do:
        - $std.log: \${msg}
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
  - $std.log: hello
  - 42
$with:
  std.log:
    $fn: msg
    $body:
      $do:
      - $std.log: 'app: \${msg}'
      - {$resume: null}
`,
        { onLog: (v) => logs.push(v) },
      ),
    ).resolves.toBe(42);
    expect(logs).toEqual(['app: hello']);
  });

  it('$resume の多重呼び出しで $std.list を自作できる', async () => {
    await expect(
      run(`
$handle:
  $do:
  - $let:
      x: {$std.each: [1, 2]}
      y: {$std.each: [10, 20]}
  - \${x + y}
$with:
  std.each:
    $fn: xs
    $body:
      $std.list:
        $do:
        - $let:
            e:
              $std.each: \${xs}
            part:
              $resume: \${e}
            r:
              $std.each: \${part}
        - \${r}
  return:
    $fn: v
    $body:
    - \${v}
`),
    ).resolves.toEqual([11, 21, 12, 22]);
  });

  it('組み込みの $std.each も同じ結果になる', async () => {
    await expect(
      run(`
$do:
- $let:
    x: {$std.each: [1, 2]}
    y: {$std.each: [10, 20]}
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
  $if: {$std.param: cond}
  $then: {$std.each: [a, b]}
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
    $if: {$std.param: cond}
    $then: {$std.each: [a, b]}
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
  $if: {$std.param: cond}
  $then: {$std.each: [a, b]}
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
        $std.each: \${xs}
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
      $if: {$std.param: with_choice}
      $then:
        f:
          $fn: x
          $body: {$std.each: [1, 2]}
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

describe('fold（$std.state + $std.list + $pipe による畳み込み）', () => {
  it('6 になる', async () => {
    await expect(
      run(`
$do:
- $let:
    fold:
      $fn: arg
      $body:
        $std.state:
          acc: \${arg.init}
        $in:
          $do:
          - $std.list:
              $do:
              - $let:
                  x:
                    $std.each: \${arg.list}
                  a: {$std.get: acc}
                  b:
                    $pipe:
                      acc: \${a}
                      x: \${x}
                    $through:
                    - \${arg.step}
              - $std.set:
                  acc: \${b}
          - {$std.get: acc}
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

describe('$op の導出形', () => {
  it('{$op: 名前} は η 展開 {$fn: x, $body: {$名前: ${x}}} と等価である', async () => {
    const ops = { 'vault.read': (k: unknown) => `secret(${String(k)})` };
    const opref = `
$do:
- $let:
    read: {$op: vault.read}
- {$.read: db/password}
`;
    const eta = `
$do:
- $let:
    read:
      $fn: x
      $body: {$vault.read: '\${x}'}
- {$.read: db/password}
`;
    await expect(run(opref, { ops })).resolves.toBe('secret(db/password)');
    await expect(run(eta, { ops })).resolves.toBe('secret(db/password)');
    // 作用の扱いも同じ：どちらも未登録なら評価前に拒否される。
    await expect(run(opref)).rejects.toThrow(/unregistered operation/);
    await expect(run(eta)).rejects.toThrow(/unregistered operation/);
  });
});

// ---------------------------------------------------------------------------
// 草案 0.4 で入った振る舞い
// ---------------------------------------------------------------------------

describe('$collect（唯一の原始演算）', () => {
  it('$with の結果リストを文書順に連結する（$into 省略時は list）', async () => {
    await expect(
      run(`
$collect: [1, 2, 3]
$with:
  $fn: x
  $body:
  - \${x}
  - \${x}
`),
    ).resolves.toEqual([1, 1, 2, 2, 3, 3]);
  });

  it('空リストを返す分岐は filter、一要素のリストは map になる', async () => {
    await expect(
      run(`
$collect: [1, 2, 3, 4]
$with:
  $fn: x
  $body:
    $if: \${x % 2 == 0}
    $then:
    - \${x * 10}
    $else: []
`),
    ).resolves.toEqual([20, 40]);
  });

  it('マッピングは {key, value} のエントリ列として文書順に回る', async () => {
    await expect(
      run(`
$collect: {web: 80, db: 5432}
$with:
  $fn: e
  $body:
  - \${e.key}=\${e.value}
`),
    ).resolves.toEqual(['web=80', 'db=5432']);
  });

  it('$into: mapping は {key, value} のエントリを集めたマッピングになる', async () => {
    const result = await run(`
$collect: {web: 80, db: 5432}
$with:
  $fn: e
  $body:
  - key: svc-\${e.key}
    value: \${e.value}
$into: mapping
`);
    expect(result).toEqual({ 'svc-web': 80, 'svc-db': 5432 });
    expect(Object.keys(result as object)).toEqual(['svc-web', 'svc-db']);
  });

  it('空の対象の値は、list なら空リスト、mapping なら空マッピング', async () => {
    await expect(run('{$collect: [], $with: {$fn: x, $body: []}}')).resolves.toEqual([]);
    await expect(
      run('{$collect: {}, $with: {$fn: x, $body: []}, $into: mapping}'),
    ).resolves.toEqual({});
  });

  it('契約違反はエラー：$with の結果がリストでない', async () => {
    await expect(run('{$collect: [1], $with: {$fn: x, $body: 5}}')).rejects.toThrow(
      /\$collect requires the \$with function to return a list/,
    );
  });

  it('契約違反はエラー：$into: mapping のエントリが {key, value} でない', async () => {
    await expect(
      run(`
$collect: [1]
$with:
  $fn: x
  $body:
  - {k: 1}
$into: mapping
`),
    ).rejects.toThrow(/exactly the keys 'key' and 'value'/);
    await expect(
      run(`
$collect: [1]
$with:
  $fn: x
  $body:
  - {key: 1, value: 2}
$into: mapping
`),
    ).rejects.toThrow(/\$collect key must be a string/);
  });

  it('契約違反はエラー：$into: mapping のキーが重複する', async () => {
    await expect(
      run(`
$collect: [1, 2]
$with:
  $fn: x
  $body:
  - key: same
    value: \${x}
$into: mapping
`),
    ).rejects.toThrow(/duplicate key in \$collect: same/);
  });

  it('対象がリストでもマッピングでもなければエラー', async () => {
    await expect(run('{$collect: 3, $with: {$fn: x, $body: []}}')).rejects.toThrow(
      /\$collect requires a list or mapping/,
    );
  });

  it('$into は list か mapping のどちらかでなければならない', async () => {
    await expect(
      run('{$collect: [], $with: {$fn: x, $body: []}, $into: set}'),
    ).rejects.toThrow(/\$into must be 'list' or 'mapping'/);
  });

  it('$with は省略できない', async () => {
    await expect(run('{$collect: []}')).rejects.toThrow(/\$collect requires \$with/);
  });

  it('$collect 自身は作用を持たず捕捉できない', async () => {
    // collect という名前の節を持つハンドラを置いても、$collect は演算ではないので素通りする。
    await expect(
      run(`
$handle:
  $collect: [1, 2]
  $with:
    $fn: x
    $body:
    - \${x}
$with:
  std.collect:
    $fn: xs
    $body: intercepted
`),
    ).resolves.toEqual([1, 2]);
  });

  it('対象と関数本体の作用は周囲へ合流する（呼び出しと同じ規則）', async () => {
    // 本体の $std.each が境界の形をリストに決める。追跡できていなければ
    // 「expected 1 result」で落ちるので、リストになること自体が算入の証拠になる。
    await expect(
      run(`
$do:
- $collect: [1, 2]
  $with:
    $fn: x
    $body:
    - {$std.each: [a, b]}
`),
    ).resolves.toEqual([
      ['a', 'a'],
      ['a', 'b'],
      ['b', 'a'],
      ['b', 'b'],
    ]);
  });

  it('対象の作用も合流する（状態を貫流させながら回れる）', async () => {
    await expect(
      run(`
$do:
- $std.set: {n: 0}
- $collect: [a, b, c]
  $with:
    $fn: x
    $body:
      $do:
      - $let:
          i: {$std.get: n}
      - $std.set:
          n: \${i + 1}
      - - \${x}\${i}
`),
    ).resolves.toEqual(['a0', 'b1', 'c2']);
  });
});

describe('第一階の標準演算', () => {
  it('$std.range は [0..n-1] を作る', async () => {
    await expect(run('{$std.range: 5}')).resolves.toEqual([0, 1, 2, 3, 4]);
    await expect(run('{$std.range: 0}')).resolves.toEqual([]);
  });

  it('$std.range の引数が自然数でなければエラー', async () => {
    for (const arg of ['-1', '2.5', "'3'", 'true']) {
      await expect(run(`{$std.range: ${arg}}`)).rejects.toThrow(
        /\$std\.range requires a natural number/,
      );
    }
  });

  it('$std.upper / $std.lower', async () => {
    await expect(run('{$std.upper: abc}')).resolves.toBe('ABC');
    await expect(run('{$std.lower: ABC}')).resolves.toBe('abc');
    await expect(run('{$std.upper: 1}')).rejects.toThrow(EffectfulYamlError);
  });

  it('$std.resolve は base を基準に path を絶対 URL にする', async () => {
    await expect(
      run(`{$std.resolve: {base: 'https://example.com/a/b/c', path: '../d'}}`),
    ).resolves.toBe('https://example.com/a/d');
    await expect(
      run(`{$std.resolve: {base: 'https://example.com/a/', path: 'https://other.example/x'}}`),
    ).resolves.toBe('https://other.example/x');
    await expect(run(`{$std.resolve: {base: 'not a url', path: 'x'}}`)).rejects.toThrow(
      /cannot resolve/,
    );
    await expect(run(`{$std.resolve: 'https://example.com'}`)).rejects.toThrow(
      /requires a mapping \{base, path\}/,
    );
  });

  it('第一階の演算は作用ではあるが選択ではないので、境界は単値のまま', async () => {
    await expect(run('a: {$std.upper: x}')).resolves.toEqual({ a: 'X' });
  });

  it('通常の演算パイプラインに乗る：節で捕捉でき、$resume で継続もできる', async () => {
    // 評価器に特例を作らず、事前登録された演算として同じ経路を通る。
    await expect(
      run(`
$handle: {$std.range: 3}
$with:
  std.range:
    $fn: n
    $body:
      $resume: [x, y]
`),
    ).resolves.toEqual(['x', 'y']);
  });

  it('ハンドラで差し替えられる（演算である以上、意味は最も近いハンドラが選ぶ）', async () => {
    await expect(
      run(`
$handle: {$std.upper: abc}
$with:
  std.upper:
    $fn: s
    $body: shouted-\${s}
`),
    ).resolves.toBe('shouted-abc');
  });
});

describe('欠落の失敗作用化', () => {
  it('存在しないキーのパスアクセスは std.fail を起こす（メッセージは維持）', async () => {
    await expect(
      run(`
$do:
- $let: {r: {a: 1}}
- \${r.b}
`),
    ).rejects.toThrow("failure: missing key 'b'");
  });

  it('範囲外の添字も std.fail を起こす', async () => {
    await expect(
      run(`
$do:
- $let: {xs: [1]}
- \${xs[3]}
`),
    ).rejects.toThrow('failure: index [3] out of range');
  });

  it('$std.opt は失敗を null に変える', async () => {
    await expect(
      run(`
$do:
- $let: {r: {a: 1}}
- present: {$std.opt: '\${r.a}'}
  missing: {$std.opt: '\${r.b}'}
`),
    ).resolves.toEqual({ present: 1, missing: null });
  });

  it('$std.prune は失敗を包囲する選択の打ち切りに変える', async () => {
    await expect(
      run(`
$std.list:
  $do:
  - $let:
      row: {$std.each: [{a: 1}, {}, {a: 3}]}
  - $std.prune: \${row.a}
`),
    ).resolves.toEqual([1, 3]);
  });

  it('$handle で捕まえれば任意の値に翻訳できる', async () => {
    await expect(
      run(`
$handle:
  $do:
  - $let: {r: {}}
  - \${r.b}
$with:
  std.fail:
    $fn: msg
    $body: 'recovered: \${msg}'
`),
    ).resolves.toBe("recovered: missing key 'b'");
  });

  it('束縛名の未定義・非コンテナの走査・型の不一致・0 除算はハードエラーのまま', async () => {
    const hard = [
      ['$std.opt: ${nope}', /undefined reference: nope/],
      ["$do: [{$let: {x: 1}}, {$std.opt: '${x.y}'}]", /cannot access key '\.y' of a non-mapping/],
      ["$do: [{$let: {x: {}}}, {$std.opt: '${x[0]}'}]", /cannot access index \[0\] of a non-list/],
      ['$std.opt: "${1 + \'a\'}"', /requires a numeric operand/],
      ["$std.opt: '${1 / 0}'", /division by zero/],
    ] as const;
    for (const [yaml, pattern] of hard) {
      // $std.opt に包んでも捕まらないことが「失敗作用ではない」ことの証拠。
      await expect(run(yaml)).rejects.toThrow(pattern);
    }
  });

  it('裸の参照は純粋なので、パスをたどる参照だけが std.fail を作用に加える', async () => {
    // $std.first は std.fail を処理するので、パス参照の失敗が最初の分岐を捨てる。
    await expect(
      run(`
$std.first:
  $do:
  - $let:
      row: {$std.each: [{}, {a: 2}]}
  - \${row.a}
`),
    ).resolves.toBe(2);
  });
});

describe('$std.first / $std.opt / $std.prune', () => {
  it('$std.first は最初の成功より後の分岐を評価しない（作用も起こさない）', async () => {
    const logs: Value[] = [];
    await expect(
      run(
        `
$std.first:
  $do:
  - $let:
      v: {$std.each: [1, 2, 3]}
  - $std.log: 'evaluated \${v}'
  - \${v}
`,
        { onLog: (v) => logs.push(v) },
      ),
    ).resolves.toBe(1);
    expect(logs).toEqual(['evaluated 1']);
  });

  it('$std.opt は $handle の std.fail 節（null を返す）への展開と等価である', async () => {
    const body = `
  $do:
  - $let: {r: {}}
  - \${r.b}
`;
    const sugar = await run(`$std.opt:${body}`);
    const expanded = await run(`
$handle:${body}
$with:
  std.fail:
    $fn: _
    $body: null
`);
    expect(sugar).toEqual(expanded);
    expect(sugar).toBe(null);
  });

  it('$std.prune の節の本体の where は、ハンドラの外側で処理される', async () => {
    // 展開: $handle の std.fail 節が {$std.where: false} を起こす。節の本体の作用は
    // このハンドラでは処理されないので、包囲する $std.list の分岐ごと打ち切られる。
    const body = `
    $do:
    - $let:
        row: {$std.each: [{a: 1}, {}]}
    - \${row.a}
`;
    const sugar = await run(`$std.list:\n  $std.prune:${body}`);
    const expanded = await run(`
$std.list:
  $handle:${body}
  $with:
    std.fail:
      $fn: _
      $body: {$std.where: false}
`);
    expect(sugar).toEqual(expanded);
    expect(sugar).toEqual([1]);
  });
});

describe('$resume（節の本体で作られた閉包から）', () => {
  it('節の本体の閉包からも、その節の起動に対応する継続を再開できる', async () => {
    await expect(
      run(`
$handle:
  $std.get: n
$with:
  std.get:
    $fn: name
    $body:
      $do:
      - $let:
          k:
            $fn: v
            $body:
              $resume: \${v}
      - {$.k: 42}
`),
    ).resolves.toBe(42);
  });

  it('継続の再開結果を $let で値として束縛し、後で適用できる（$std.state の展開の形）', async () => {
    // 仕様の $std.state の展開そのもの：節が状態変換関数を返し、再開結果もまた
    // 状態変換関数なので、それを現在の状態に適用して続ける。
    // ここは読み出し専用の一セルに縮めた最小形で、21 を読んで 2 倍する。
    await expect(
      run(`
$do:
- $let:
    f:
      $handle:
        $do:
        - $let:
            v: {$std.get: acc}
        - \${v * 2}
      $with:
        std.get:
          $fn: name
          $body:
            $fn: s
            $body:
              $do:
              - $let:
                  k:
                    $resume: \${s}
              - $.k: \${s}
        return:
          $fn: x
          $body:
            $fn: s
            $body: \${x}
- {$.f: 21}
`),
    ).resolves.toBe(42);
  });

  it('$std.list は仕様の展開（std.each / std.where / return の節）と同じ値になる', async () => {
    // 実装は等価な組み込みで最適化してよいが、観測できる振る舞いは展開と一致しなければならない。
    // 本体は内包表記（選択と打ち切りの両方を含む）。
    const body = `
  $do:
  - $let:
      x: {$std.each: [1, 2, 3]}
      y: {$std.each: [1, 2, 3]}
  - $std.where: \${x < y}
  - - \${x}
    - \${y}
`;
    const expanded = await run(`
$handle:${body}
$with:
  std.each:
    $fn: xs
    $body:
      $collect: \${xs}
      $with:
        $fn: x
        $body:
          $resume: \${x}
  std.where:
    $fn: b
    $body:
      $if: \${b}
      $then:
        $resume: null
      $else: []
  return:
    $fn: x
    $body:
    - \${x}
`);
    const builtin = await run(`$std.list:${body}`);
    expect(expanded).toEqual(builtin);
    expect(builtin).toEqual([
      [1, 2],
      [1, 3],
      [2, 3],
    ]);
  });

  it('閉包経由でも多重再開できる（$std.list を自作する）', async () => {
    await expect(
      run(`
$handle:
  $do:
  - $let:
      x: {$std.each: [1, 2]}
  - \${x * 10}
$with:
  std.each:
    $fn: xs
    $body:
      $do:
      - $let:
          k:
            $fn: v
            $body:
              $resume: \${v}
      - $collect: \${xs}
        $with:
          $fn: e
          $body:
            $.k: \${e}
  return:
    $fn: v
    $body:
    - \${v}
`),
    ).resolves.toEqual([10, 20]);
  });
});

describe('予約キーと名前空間（草案 0.4）', () => {
  it('旧記法のドットなしキーは「予約されていない $ キー」のエラーになる', async () => {
    const old = ['each', 'where', 'param', 'get', 'set', 'log', 'fail', 'list', 'first', 'mapping', 'state'];
    for (const name of old) {
      await expect(run(`{$${name}: x}`)).rejects.toThrow(`unreserved $ key: $${name}`);
    }
  });

  it('$in と $default は std の演算の補助キーとしてだけ有効', async () => {
    await expect(run('{$in: 1}')).rejects.toThrow(/auxiliary \$ key without a main key/);
    await expect(run('{$default: 1}')).rejects.toThrow(/auxiliary \$ key without a main key/);
    await expect(run('{$do: [], $in: 1}')).rejects.toThrow(/\$do does not accept \$in/);
    await expect(run('{$std.log: x, $default: 1}')).rejects.toThrow(
      /\$std\.log does not accept \$default/,
    );
  });

  it('$std.state は $in を要求する', async () => {
    await expect(run('{$std.state: {}}')).rejects.toThrow(/\$std\.state requires \$in/);
  });

  it('ホストは std. 名前空間に演算を登録できない', async () => {
    await expect(run('x: 1', { ops: { 'std.each': () => null } })).rejects.toThrow(
      /host cannot register an operation in the std namespace: \$std\.each/,
    );
    await expect(run('x: 1', { ops: { 'std.myop': () => null } })).rejects.toThrow(
      /host cannot register an operation in the std namespace/,
    );
  });

  it('$op はドット入りの演算名だけを参照でき、派生ハンドラは参照できない', async () => {
    await expect(run('{$op: each}')).rejects.toThrow(/namespaced operation name/);
    await expect(run('{$op: std.list}')).rejects.toThrow(/cannot reference the derived handler/);
    await expect(run('{$op: std.state}')).rejects.toThrow(/cannot reference the derived handler/);
  });

  it('$handle の節名はドット入りの演算名か return でなければならない', async () => {
    await expect(
      run(`
$handle: 1
$with:
  fail:
    $fn: m
    $body: x
`),
    ).rejects.toThrow(/clause name must be a namespaced operation name or 'return'/);
  });

  it('節に挙げた演算は登録が要らない（事前検査はどの節にも現れない演算だけを拒む）', async () => {
    await expect(
      run(`
$handle: {$vault.read: db/password}
$with:
  vault.read:
    $fn: key
    $body: handled-\${key}
`),
    ).resolves.toBe('handled-db/password');
    await expect(run('{$vault.read: db/password}')).rejects.toThrow(
      /unregistered operation: \$vault\.read/,
    );
  });

  it('std の演算は登録演算と同じ演算パイプラインを通る（節で差し替えられる）', async () => {
    await expect(
      run(`
$handle:
  $do:
  - $std.set: {n: 1}
  - {$std.get: n}
$with:
  std.get:
    $fn: name
    $body:
      $resume: shadowed-\${name}
  std.set:
    $fn: cells
    $body: {$resume: null}
`),
    ).resolves.toBe('shadowed-n');
  });
});

describe('ホスト演算の失敗通知', () => {
  it('捕捉されなければ、呼び出し位置の std.fail が文書全体のエラーになる', async () => {
    await expect(
      run('{$site.sel: h1}', {
        ops: {
          'site.sel': () => {
            throw new OperationFailure('no match: h1');
          },
        },
      }),
    ).rejects.toThrow(/failure: no match: h1/);
  });

  it('$std.opt が捕捉して null になる', async () => {
    await expect(
      run('{$std.opt: {$site.sel: h1}}', {
        ops: {
          'site.sel': () => {
            throw new OperationFailure('no match: h1');
          },
        },
      }),
    ).resolves.toBe(null);
  });

  it('$std.prune が失敗した分岐だけを落とす', async () => {
    await expect(
      run(
        `
$std.list:
  $do:
  - $let:
      v: {$std.each: [a, b, c]}
  - $std.prune:
      $site.sel: \${v}
`,
        {
          ops: {
            'site.sel': (v) => {
              if (v === 'b') throw new OperationFailure('no match: b');
              return v;
            },
          },
        },
      ),
    ).resolves.toEqual(['a', 'c']);
  });

  it('$handle の std.fail 節が $resume で呼び出し位置に代替値を返し、続く計算に反映される', async () => {
    await expect(
      run(
        `
$handle:
  $do:
  - $let:
      v:
        $site.sel: h1
  - prefix-\${v}
$with:
  std.fail:
    $fn: msg
    $body: {$resume: fallback}
`,
        {
          ops: {
            'site.sel': () => {
              throw new OperationFailure('no match: h1');
            },
          },
        },
      ),
    ).resolves.toBe('prefix-fallback');
  });

  it('OperationFailure でない例外は $std.opt でも捕捉されず reject される', async () => {
    await expect(
      run('{$std.opt: {$site.sel: h1}}', {
        ops: {
          'site.sel': () => {
            throw new Error('boom');
          },
        },
      }),
    ).rejects.toThrow(/boom/);
  });

  it('$std.first は失敗した分岐を飛ばして次の分岐の値になる', async () => {
    await expect(
      run(
        `
$std.first:
  $do:
  - $let:
      v: {$std.each: [x, y]}
  - $site.sel: \${v}
`,
        {
          ops: {
            'site.sel': (v) => {
              if (v === 'x') throw new OperationFailure('no match: x');
              return v;
            },
          },
        },
      ),
    ).resolves.toBe('y');
  });
});
