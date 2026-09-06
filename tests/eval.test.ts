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
$std.list:
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
$std.list:
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
$std.list:
  $do:
  - $let:
      e: {$std.each: {web: 80, db: 5432}}
  - \${e.key}
`),
    ).resolves.toEqual(['web', 'db']);
  });

  it('リストの要素は合成なので、選択は外側のブロック全体を分岐させる', async () => {
    await expect(run('$std.list: {$do: [[1, {$std.each: [a, b]}]]}')).resolves.toEqual([
      [1, 'a'],
      [1, 'b'],
    ]);
  });

  it('演算の引数も合成なので、$std.each の入れ子が平坦化される', async () => {
    await expect(run('{$std.list: {$std.each: {$std.each: [[1, 2], [3, 4]]}}}')).resolves.toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('データ文脈では最も外側の $ 式だけが境界になる（$do の中との対比）', async () => {
    // 上の $do のテストでは同じ字面がブロック全体を分岐させる。
    // データ文脈では {$std.list} 自身が境界なので、収集はその中で閉じる。
    await expect(run('x: [1, {$std.list: {$std.each: [a, b]}}]')).resolves.toEqual({
      x: [1, ['a', 'b']],
    });
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
$std.list:
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

  it('境界に単独で置くと、真は null、偽は打ち切りの選択が境界に達してエラーになる', async () => {
    await expect(run('{$std.where: true}')).resolves.toBeNull();
    await expect(run('{$std.where: false}')).rejects.toThrow(/unhandled choice/);
    await expect(run('{$std.list: {$std.where: true}}')).resolves.toEqual([null]);
    await expect(run('{$std.list: {$std.where: false}}')).resolves.toEqual([]);
  });

  it('打ち切りは展開のとおり std.each の節が捕捉する', async () => {
    await expect(
      run(`
$in:
  $do:
  - $std.where: false
  - after
$with:
  std.each:
    $fn: xs
    $body: caught
`),
    ).resolves.toBe('caught');
  });

  it('std.where という節では捕捉できない（演算ではないため）', async () => {
    // 節は死節になり、打ち切り（空の std.each）は外側の $std.list が処理する。
    await expect(
      run(`
$std.list:
  $in:
    $do:
    - $std.where: false
    - after
  $with:
    std.where:
      $fn: _
      $body: caught
`),
    ).resolves.toEqual([]);
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
    // 失敗が既定ハンドラ（境界）で起きるのだと、呼び出し位置を包むハンドラはもう戻っている。
    // $default の展開が成り立つには、失敗が呼び出し位置で生じなければならない。
    await expect(
      run(`
$in: {$std.param: nope}
$with:
  std.fail:
    $fn: msg
    $body: caught \${msg}
`),
    ).resolves.toBe('caught parameter not provided: nope');
    await expect(run('{$std.opt: {$std.param: nope}}')).resolves.toBe(null);
  });

  it('{$std.param: 名前, $default: 式} は std.fail 節への展開と等価である', async () => {
    // 展開: {$std.param: 名前} を $with で包み、std.fail の節で $default の式を返す。
    const expanded = `
$in: {$std.param: port}
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

  it('$default は評価されないので、その中の選択も起きない', async () => {
    // 渡されていれば $default は評価されず、選択が境界に達することもない。
    await expect(
      run('{$std.param: x, $default: {$std.each: [1, 2]}}', { params: { x: 5 } }),
    ).resolves.toBe(5);
    await expect(run('{$std.param: x, $default: {$std.each: [1, 2]}}')).rejects.toThrow(
      /unhandled choice/,
    );
    await expect(
      run('{$std.list: {$std.param: x, $default: {$std.each: [1, 2]}}}'),
    ).resolves.toEqual([1, 2]);
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
$std.list:
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
    // 節の本体の作用はそのハンドラ自身ではなく外側で処理される（$with の規則）ので、
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
$std.list:
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
$std.list:
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

describe('$fn', () => {
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

  it('引数を素通しする $fn で登録演算に短い名前を付ける', async () => {
    await expect(
      run(
        `
$do:
- $let:
    read:
      $fn: key
      $body: {$vault.secrets.read: '\${key}'}
- {$.read: db/password}
`,
        { ops: { 'vault.secrets.read': (k) => `secret(${String(k)})` } },
      ),
    ).resolves.toBe('secret(db/password)');
  });

  it('呼び出しの入れ子が合成になる', async () => {
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
- $.succ:
    $.double: 20
`),
    ).resolves.toBe(41);
  });

  it('呼び出しの引数は合成なので、引数の選択が呼び出しごと分岐する', async () => {
    await expect(
      run(`
$std.list:
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

  it('$with の節は一引数で呼ばれるので、多引数の節は閉包が値になり脱出のエラーに至る', async () => {
    await expect(
      run(`
$in: {$std.fail: boom}
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

describe('$with / $in / $resume', () => {
  it('失敗を捕捉して既定値に置き換える', async () => {
    const logs: Value[] = [];
    await expect(
      run(
        `
port:
  $in:
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
$in:
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
$in:
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
$std.list:
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

describe('境界に達した選択', () => {
  it('選ばれなかった分岐の選択は起きない（$else 側なら値は単値のまま）', async () => {
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
    ).resolves.toEqual({ result: 42 });
  });

  it('$do の内側でも同じで、選ばれない分岐の選択は文書の値に影響しない', async () => {
    // $if は最も外側の $ 式ではない（$do の内側）ので境界ではない。
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
    ).resolves.toEqual({ result: 42 });
  });

  it('選ばれた側が選択なら、ハンドラが無い限り境界でエラーになる', async () => {
    const doc = `
result:
  $if: {$std.param: cond}
  $then: {$std.each: [a, b]}
  $else: 42
`;
    await expect(run(doc, { params: { cond: true } })).rejects.toThrow(/unhandled choice/);
    await expect(
      run(
        `
result:
  $std.list:
    $if: {$std.param: cond}
    $then: {$std.each: [a, b]}
    $else: 42
`,
        { params: { cond: true } },
      ),
    ).resolves.toEqual({ result: ['a', 'b'] });
  });

  it('関数の本体の選択も、呼び出しを包む選択のハンドラが処理する', async () => {
    await expect(
      run(`
$std.list:
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

  it('$with が節を与えた演算は登録されていなくてよい', async () => {
    await expect(
      run(`
$in: {$vault.read: db/password}
$with:
  vault.read:
    $fn: key
    $body: handled-\${key}
`),
    ).resolves.toBe('handled-db/password');
  });
});

describe('fold（$std.state + $std.list による畳み込み）', () => {
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
                    $.arg.step:
                      acc: \${a}
                      x: \${x}
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
    // $fn の本体は呼び出し側だけが走査する。定義ごとに走査すると 2^深さ に爆発する。
    let body: unknown = '${x}';
    for (let i = 0; i < 32; i++) {
      body = { $do: [{ $let: { f: { $fn: 'x', $body: body } } }, { '$.f': i }] };
    }
    await expect(evaluate(body)).resolves.toBe(0);
  });
});

describe('$collect（畳み込みのカーネル構文）', () => {
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
$in:
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
    // 関数本体の $std.each は $collect に堰き止められず、外側の $std.list が集める。
    await expect(
      run(`
$std.list:
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

  it('第一階の演算は作用ではあるが選択ではないので、境界は単値のまま', async () => {
    // リストは std.range 自身の値であり、境界が分岐を集めた結果ではない。
    await expect(run('a: {$std.range: 3}')).resolves.toEqual({ a: [0, 1, 2] });
  });

  it('通常の演算パイプラインに乗る：節で捕捉でき、$resume で継続もできる', async () => {
    // 評価器に特例を作らず、事前登録された演算として同じ経路を通る。
    await expect(
      run(`
$in: {$std.range: 3}
$with:
  std.range:
    $fn: n
    $body:
      $resume: [x, y]
`),
    ).resolves.toEqual(['x', 'y']);
  });

  it('ハンドラで差し替えられる（演算である以上、意味は最も近いハンドラが選ぶ）', async () => {
    // std の演算に限らず、任意の登録演算の名前で差し替えられることを示す。
    await expect(
      run(`
$in: {$str.upper: abc}
$with:
  str.upper:
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

  it('打ち切りの定型（$default: {$std.where: false}）は失敗を包囲する選択の打ち切りに変える', async () => {
    await expect(
      run(`
$std.list:
  $do:
  - $let:
      row: {$std.each: [{a: 1}, {}, {a: 3}]}
  - $std.opt: \${row.a}
    $default: {$std.where: false}
`),
    ).resolves.toEqual([1, 3]);
  });

  it('$with で捕まえれば任意の値に翻訳できる', async () => {
    await expect(
      run(`
$in:
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

describe('$std.first / $std.opt', () => {
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

  it('$std.opt は $with の std.fail 節（null を返す）への展開と等価である', async () => {
    const body = `
  $do:
  - $let: {r: {}}
  - \${r.b}
`;
    const sugar = await run(`$std.opt:${body}`);
    const expanded = await run(`
$in:${body}
$with:
  std.fail:
    $fn: _
    $body: null
`);
    expect(sugar).toEqual(expanded);
    expect(sugar).toBe(null);
  });

  it('打ち切りの定型の $default が起こす where は、ハンドラの外側で処理される', async () => {
    // 展開: $with の std.fail 節が {$std.where: false} を起こす。節の本体の作用は
    // このハンドラでは処理されないので、包囲する $std.list の分岐ごと打ち切られる。
    const body = `
    $do:
    - $let:
        row: {$std.each: [{a: 1}, {}]}
    - \${row.a}
`;
    const sugar = await run(`$std.list:\n  $std.opt:${body}  $default: {$std.where: false}\n`);
    const expanded = await run(`
$std.list:
  $in:${body}
  $with:
    std.fail:
      $fn: _
      $body: {$std.where: false}
`);
    expect(sugar).toEqual(expanded);
    expect(sugar).toEqual([1]);
  });
});

describe('$std.opt の $default', () => {
  it('欠落したパスアクセスの失敗は $default の値になる', async () => {
    await expect(
      run(`
$do:
- $let: {m: {}}
- $std.opt: \${m.nope}
  $default: fallback
`),
    ).resolves.toBe('fallback');
  });

  it('成功時は本体の値になり、$default は評価されない', async () => {
    const logs: Value[] = [];
    await expect(
      run(
        `
$std.opt: ok
$default:
  $do:
  - $std.log: defaulted
  - fallback
`,
        { onLog: (v) => logs.push(v) },
      ),
    ).resolves.toBe('ok');
    expect(logs).toEqual([]);
  });

  it('失敗時は $default が一度だけ評価される', async () => {
    const logs: Value[] = [];
    await expect(
      run(
        `
$do:
- $let: {m: {}}
- $std.opt: \${m.nope}
  $default:
    $do:
    - $std.log: defaulted
    - fallback
`,
        { onLog: (v) => logs.push(v) },
      ),
    ).resolves.toBe('fallback');
    expect(logs).toEqual(['defaulted']);
  });

  it('$default の式自身が失敗すると外へ伝播して reject される', async () => {
    await expect(
      run(`
$do:
- $let: {m: {}}
- $std.opt: \${m.nope}
  $default: {$std.fail: still missing}
`),
    ).rejects.toThrow('failure: still missing');
  });

  it('$default: {} のような空マッピングも既定値にできる', async () => {
    await expect(
      run(`
$do:
- $let: {m: {}}
- $std.opt: \${m.nope}
  $default: {}
`),
    ).resolves.toEqual({});
  });

  it('未渡しパラメータの失敗も捕捉できる', async () => {
    await expect(run('{$std.opt: {$std.param: nope}, $default: 5}')).resolves.toBe(5);
  });

  it('$default を取らない主キーとの組み合わせは形の誤りになる', async () => {
    await expect(run('{$std.list: 1, $default: 2}')).rejects.toThrow(/does not accept \$default/);
  });

  it('本体が成功すれば $default は評価されず、その中の選択も起きない（$std.param の $default と同じ）', async () => {
    await expect(run('{$std.opt: ok, $default: {$std.each: [1, 2]}}')).resolves.toBe('ok');
  });

  it('ホスト演算の失敗通知（OperationFailure）も $default で埋められる', async () => {
    await expect(
      run('{$std.opt: {$x.op: a}, $default: d}', {
        ops: {
          'x.op': () => {
            throw new OperationFailure('no match: a');
          },
        },
      }),
    ).resolves.toBe('d');
  });
});

describe('$std.lookup', () => {
  it('キーが在ればその値になる', async () => {
    await expect(
      run(`
$do:
- $let:
    table: {a: 1, b: 2}
    label: b
- $std.lookup:
    in: \${table}
    key: \${label}
`),
    ).resolves.toBe(2);
  });

  it('無いキーは捕捉しなければ missing key のメッセージで reject される', async () => {
    await expect(
      run(`
$do:
- $let:
    table: {a: 1}
- $std.lookup:
    in: \${table}
    key: x
`),
    ).rejects.toThrow(/failure: missing key 'x'/);
  });

  it('$std.opt + $default と合成すると既定値になる', async () => {
    await expect(
      run(`
$do:
- $let:
    table: {a: 1}
- $std.opt:
    $std.lookup:
      in: \${table}
      key: x
  $default: fallback
`),
    ).resolves.toBe('fallback');
  });

  it('$std.list の中で打ち切りの定型と合成すると、無いキーの分岐だけが落ちる', async () => {
    await expect(
      run(`
$std.list:
  $do:
  - $let:
      row:
        $std.each:
        - {t: {a: 1}, k: a}
        - {t: {a: 1}, k: x}
        - {t: {a: 1}, k: a}
  - $std.opt:
      $std.lookup:
        in: \${row.t}
        key: \${row.k}
    $default: {$std.where: false}
`),
    ).resolves.toEqual([1, 1]);
  });

  it("'in' がマッピングでなければエラーになり、$std.opt でも捕捉できない（形の誤り）", async () => {
    await expect(run('{$std.lookup: {in: [1, 2, 3], key: a}}')).rejects.toThrow(
      /'in' must be a mapping/,
    );
    await expect(
      run('{$std.opt: {$std.lookup: {in: [1, 2, 3], key: a}}}'),
    ).rejects.toThrow(/'in' must be a mapping/);
  });

  it('key が文字列でなければエラーになり、$std.opt でも捕捉できない（形の誤り）', async () => {
    await expect(run('{$std.lookup: {in: {a: 1}, key: 1}}')).rejects.toThrow(
      /\$std\.lookup key must be a string/,
    );
    await expect(
      run('{$std.opt: {$std.lookup: {in: {a: 1}, key: 1}}}'),
    ).rejects.toThrow(/\$std\.lookup key must be a string/);
  });

  it('引数全体を束縛で与える形（{in, key} のマッピングをまるごと渡す）でも動く', async () => {
    await expect(
      run(`
$do:
- $let:
    pair: {in: {a: 1, b: 2}, key: b}
- $std.lookup: \${pair}
`),
    ).resolves.toBe(2);
  });

  it('展開の中の選択は $std.first が処理し尽くすので外へ出ず、ops の登録も要らない', async () => {
    await expect(
      run(`
$std.lookup:
  in: {a: 1}
  key: a
`),
    ).resolves.toBe(1);
  });
});

describe('$std.merge', () => {
  it('値は後勝ち、キーの位置は初出（Object.keys の順）', async () => {
    const result = await run(`
$std.merge:
- {b: 2, a: 1, keep: base}
- {b: 9, c: 3}
`);
    expect(result).toEqual({ b: 9, a: 1, keep: 'base', c: 3 });
    expect(Object.keys(result as object)).toEqual(['b', 'a', 'keep', 'c']);
  });

  it('空リストは空マッピング、要素 1 つはそのマッピングのまま', async () => {
    await expect(run('{$std.merge: []}')).resolves.toEqual({});
    await expect(run('{$std.merge: [{a: 1, b: 2}]}')).resolves.toEqual({ a: 1, b: 2 });
  });

  it('3 つ以上の重ねは後勝ちの連鎖になる', async () => {
    await expect(
      run(`
$std.merge:
- {a: 1}
- {a: 2, b: 1}
- {a: 3, c: 1}
`),
    ).resolves.toEqual({ a: 3, b: 1, c: 1 });
  });

  it('null は普通の値として上書きする', async () => {
    await expect(run('{$std.merge: [{x: 1}, {x: null}]}')).resolves.toEqual({ x: null });
  });

  it('引数は式でよい（$let で束縛したリストを渡すデータ駆動）', async () => {
    await expect(
      run(`
$do:
- $let:
    xs:
    - {a: 1}
    - {a: 2, b: 3}
- $std.merge: \${xs}
`),
    ).resolves.toEqual({ a: 2, b: 3 });
  });

  it('引数がリストでない・要素がマッピングでないのは形の誤りで、$std.opt でも捕捉できない', async () => {
    await expect(run('{$std.merge: {a: 1}}')).rejects.toThrow(
      /\$std\.merge requires a list of mappings/,
    );
    await expect(run('{$std.opt: {$std.merge: {a: 1}}}')).rejects.toThrow(
      /\$std\.merge requires a list of mappings/,
    );
    await expect(run('{$std.merge: [1, 2]}')).rejects.toThrow(
      /\$std\.merge element must be a mapping/,
    );
    await expect(run('{$std.opt: {$std.merge: [1, 2]}}')).rejects.toThrow(
      /\$std\.merge element must be a mapping/,
    );
  });

  it('引数の中に $std.each があると merge 全体が分岐する（値は各分岐の merge 結果）', async () => {
    await expect(
      run(`
$std.list:
  $std.merge:
  - $std.each:
    - {x: 1}
    - {x: 2}
  - {y: 3}
`),
    ).resolves.toEqual([
      { x: 1, y: 3 },
      { x: 2, y: 3 },
    ]);
  });

  it('純粋な引数だけの $std.merge は境界で単値のまま（リスト化されない）', async () => {
    await expect(run('a: {$std.merge: [{x: 1}, {y: 2}]}')).resolves.toEqual({
      a: { x: 1, y: 2 },
    });
  });

  it('$with の std.merge 節は発火しない（組み込みの経路を通るため、節が値を返しても素通しになる）', async () => {
    await expect(
      run(`
$in:
  $std.merge:
  - {a: 1}
  - {b: 2}
$with:
  std.merge:
    $fn: _
    $body: caught
`),
    ).resolves.toEqual({ a: 1, b: 2 });
  });

  it('引数の要素の値の中の $std.fail は伝播し、外の $std.opt で捕捉できる', async () => {
    await expect(
      run(`
$std.opt:
  $std.merge:
  - {a: 1}
  - b: {$std.fail: nope}
$default: fallback
`),
    ).resolves.toBe('fallback');
  });
});

describe('$resume（節の本体で作られた閉包から）', () => {
  it('節の本体の閉包からも、その節の起動に対応する継続を再開できる', async () => {
    await expect(
      run(`
$in:
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
      $in:
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

  it('$std.list は仕様の展開（std.each / return の節）と同じ値になる', async () => {
    // 実装は等価な組み込みで最適化してよいが、観測できる振る舞いは展開と一致しなければならない。
    // 本体は内包表記（選択と打ち切りの両方を含む）。$std.where の打ち切りは
    // 展開により空の $std.each として現れるので、std.each の節だけで処理できる。
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
$in:${body}
$with:
  std.each:
    $fn: xs
    $body:
      $collect: \${xs}
      $with:
        $fn: x
        $body:
          $resume: \${x}
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
$in:
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

describe('予約キーと名前空間', () => {
  it('予約されていないドットなしキーは「予約されていない $ キー」のエラーになる', async () => {
    const names = ['each', 'where', 'param', 'get', 'set', 'log', 'fail', 'list', 'first', 'mapping', 'state'];
    for (const name of names) {
      await expect(run(`{$${name}: x}`)).rejects.toThrow(`unreserved $ key: $${name}`);
    }
  });

  it('削除した $op $pipe $through も「予約されていない $ キー」のエラーになる', async () => {
    for (const name of ['op', 'pipe', 'through']) {
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

  it('$in を省いた $std.state と単独の $with は $do の文の位置でだけ書ける', async () => {
    await expect(run('{$std.state: {}}')).rejects.toThrow(
      /\$std\.state without \$in is only allowed as a statement of \$do/,
    );
    await expect(run('{$with: {std.fail: {$fn: m, $body: x}}}')).rejects.toThrow(
      /\$with without \$in is only allowed as a statement of \$do/,
    );
  });

  it('ホストは std. 名前空間に演算を登録できない', async () => {
    await expect(run('x: 1', { ops: { 'std.each': () => null } })).rejects.toThrow(
      /host cannot register an operation in the std namespace: \$std\.each/,
    );
    await expect(run('x: 1', { ops: { 'std.myop': () => null } })).rejects.toThrow(
      /host cannot register an operation in the std namespace/,
    );
  });

  it('$with の節名は演算名か裸のローカル名か return でなければならない', async () => {
    // 裸の名前はローカル作用の宣言なので、誤りなのは `$` 始まりと壊れたドット区切りである。
    for (const name of ['$fail', 'a..b']) {
      await expect(
        run(`
$in: 1
$with:
  ${JSON.stringify(name)}:
    $fn: m
    $body: x
`),
      ).rejects.toThrow(
        /clause name must be an operation name, a bare local name, or 'return'/,
      );
    }
  });

  it('節に挙げた演算は登録が要らない（事前検査はどの節にも現れない演算だけを拒む）', async () => {
    await expect(
      run(`
$in: {$vault.read: db/password}
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
$in:
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

  it('打ち切りの定型が失敗した分岐だけを落とす', async () => {
    await expect(
      run(
        `
$std.list:
  $do:
  - $let:
      v: {$std.each: [a, b, c]}
  - $std.opt:
      $site.sel: \${v}
    $default: {$std.where: false}
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

  it('$with の std.fail 節が $resume で呼び出し位置に代替値を返し、続く計算に反映される', async () => {
    await expect(
      run(
        `
$in:
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

  it('別の複製の OperationFailure（名前と value が同じ形の Error）も通知として扱う', async () => {
    const foreign = Object.assign(new Error('no match: h1'), { name: 'OperationFailure', value: 'no match: h1' });
    const ops = {
      'site.sel': () => {
        throw foreign;
      },
    };
    await expect(run('{$std.opt: {$site.sel: h1}, $default: none}', { ops })).resolves.toBe('none');
    await expect(run('{$site.sel: h1}', { ops })).rejects.toThrow('failure: no match: h1');
  });

  it('名前が OperationFailure でも value を持たない Error は通知ではなく捕捉できないエラー', async () => {
    await expect(
      run('{$std.opt: {$site.sel: h1}}', {
        ops: {
          'site.sel': () => {
            throw Object.assign(new Error('boom'), { name: 'OperationFailure' });
          },
        },
      }),
    ).rejects.toThrow(/boom/);
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

describe('$let（$in）', () => {
  it('$let は右辺を文書順に束縛して $in の本体を評価する', async () => {
    await expect(
      run(`
$let:
  x: 2
  y: \${x + 1}
$in: \${x * y}
`),
    ).resolves.toBe(6);
  });

  it('入れ子の $let の再束縛は外側の束縛を隠す', async () => {
    await expect(
      run(`
$let:
  x: 1
$in:
  $let:
    x: 2
  $in: \${x}
`),
    ).resolves.toBe(2);
  });

  it('右辺の選択は包囲する逐次の全体を分岐させ、選択のハンドラがリストに集める', async () => {
    await expect(
      run(`
$std.list:
  $let:
    x: {$std.each: [1, 2]}
  $in: \${x * 10}
`),
    ).resolves.toEqual([10, 20]);
  });

  it('捨て名 _ への束縛で値を捨てて作用だけを残せる', async () => {
    const logs: Value[] = [];
    await expect(
      run(
        `
$let:
  _: {$std.log: hi}
$in: ok
`,
        { onLog: (v) => logs.push(v) },
      ),
    ).resolves.toBe('ok');
    expect(logs).toEqual(['hi']);
  });

  it('$let で束縛した関数の本体の選択も、外側の選択のハンドラが集める', async () => {
    await expect(
      run(`
$std.list:
  $let:
    pick:
      $fn: xs
      $body:
        $std.each: \${xs}
  $in:
    $.pick: [a, b]
`),
    ).resolves.toEqual(['a', 'b']);
  });

  it('$in を伴う $let は $do の文としては完結した式であり、束縛を残りの文へ伸ばさない', async () => {
    await expect(
      run(`
$do:
- $let:
    x: 1
  $in: \${x}
- \${x}
`),
    ).rejects.toThrow(/undefined reference/);
  });

  it('$in の無い $let を $do の外に置くとエラー', async () => {
    await expect(run('{$let: {x: 1}}')).rejects.toThrow(
      /\$let without \$in is only allowed as a statement of \$do/,
    );
  });

  it('束縛がマッピングでなければエラー', async () => {
    await expect(run('{$let: [1], $in: null}')).rejects.toThrow(
      /\$let requires a mapping of bindings/,
    );
  });

  it('束縛名にドットは使えない', async () => {
    await expect(run('{$let: {a.b: 1}, $in: null}')).rejects.toThrow(/must not contain a dot/);
  });
});

describe('$do の文形（$with 文 / $std.state 文）', () => {
  it('先の $with 文ほど外側のハンドラになる（近い方が勝つ）', async () => {
    await expect(
      run(`
$do:
- $with:
    std.fail: {$fn: _, $body: outer}
- $with:
    std.fail: {$fn: _, $body: inner}
- {$std.fail: boom}
`),
    ).resolves.toBe('inner');
  });

  it('節の本体が起こす作用は自分では捕まらず、外側の $with 文が処理する', async () => {
    await expect(
      run(`
$do:
- $with:
    std.fail: {$fn: _, $body: outer}
- $with:
    std.fail:
      $fn: _
      $body:
        $std.lookup: {in: {}, key: missing}
- {$std.fail: boom}
`),
    ).resolves.toBe('outer');
  });

  it('節は文の位置の環境で閉じるので、先行する $let 文の束縛が見える', async () => {
    await expect(
      run(`
$do:
- $let:
    d: fallback
- $with:
    std.fail:
      $fn: _
      $body: \${d}
- {$std.fail: boom}
`),
    ).resolves.toBe('fallback');
  });

  it('$resume する節を $with 文で仕掛けると、後続の文の演算を横取りできる', async () => {
    const logs: Value[] = [];
    await expect(
      run(
        `
$do:
- $with:
    std.log:
      $fn: m
      $body: {$resume: null}
- $std.log: hello
- done
`,
        { onLog: (v) => logs.push(v) },
      ),
    ).resolves.toBe('done');
    expect(logs).toEqual([]);
  });

  it('末尾に置いた文形の値は null（$with 文は return 節を通る）', async () => {
    await expect(run('{$do: [{$with: {std.fail: {$fn: _, $body: x}}}]}')).resolves.toBe(null);
    await expect(run('{$do: [{$std.state: {n: 0}}]}')).resolves.toBe(null);
    await expect(
      run(`
$do:
- $with:
    return: {$fn: v, $body: wrapped}
`),
    ).resolves.toBe('wrapped');
  });

  it('$std.state 文は残りの文に記憶を通す（$in を伴う完結形は残りの文に及ばない）', async () => {
    await expect(
      run(`
$do:
- $std.state: {n: 5}
  $in: {$std.get: n}
- done
`),
    ).resolves.toBe('done');
    await expect(
      run(`
$do:
- $std.state: {n: 5}
  $in: {$std.get: n}
- {$std.get: n}
`),
    ).rejects.toThrow(/uninitialized cell: n/);
  });

  it('文の位置の外ではエラー', async () => {
    await expect(
      run('{$do: [{$let: {x: {$with: {std.fail: {$fn: _, $body: 0}}}}}, 1]}'),
    ).rejects.toThrow(/\$with without \$in is only allowed as a statement of \$do/);
    await expect(run('{$do: [{$let: {x: {$std.state: {n: 0}}}}, 1]}')).rejects.toThrow(
      /\$std\.state without \$in is only allowed as a statement of \$do/,
    );
  });

});

describe('__proto__ キーの防御', () => {
  const ownProto = (v: Value): boolean => Object.prototype.hasOwnProperty.call(v as object, '__proto__');
  const at = (v: Value, k: string): Value => (v as { [key: string]: Value })[k]!;

  it('値だけの文書の __proto__ キーは自身のプロパティとして残る（identity）', async () => {
    const r = await run('"__proto__": {x: 1}\na: 2');
    expect(Object.keys(r as object)).toEqual(['__proto__', 'a']);
    expect(ownProto(r)).toBe(true);
    expect(at(r, '__proto__')).toEqual({ x: 1 });
    // プロトタイプは差し替わらず、継承経由でデータが漏れない
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
    expect((r as { x?: Value }).x).toBeUndefined();
  });

  it('$std.mapping の計算したキーが __proto__ でもエントリになる', async () => {
    const r = await run(`
$std.mapping:
  $let:
    k:
      $std.each: [__proto__]
  $in:
    key: ${'${k}'}
    value: {x: 1}
`);
    expect(Object.keys(r as object)).toEqual(['__proto__']);
    expect(ownProto(r)).toBe(true);
    expect(at(r, '__proto__')).toEqual({ x: 1 });
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
  });

  it('$std.merge は __proto__ を普通のキーとして重ねる', async () => {
    const r = await run(`
$std.merge:
- a: 1
- "__proto__": {x: 1}
`);
    expect(Object.keys(r as object)).toEqual(['a', '__proto__']);
    expect(ownProto(r)).toBe(true);
    expect(at(r, '__proto__')).toEqual({ x: 1 });
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
  });

  it('$collect の into: mapping でも __proto__ はエントリになり、重複も検出される', async () => {
    const r = await run(`
$collect:
- __proto__
$with:
  $fn: k
  $body:
  - key: ${'${k}'}
    value: {x: 1}
$into: mapping
`);
    expect(ownProto(r)).toBe(true);
    await expect(
      run(`
$collect:
- __proto__
- __proto__
$with:
  $fn: k
  $body:
  - key: ${'${k}'}
    value: {x: 1}
$into: mapping
`),
    ).rejects.toThrow(/duplicate key in \$collect: __proto__/);
  });

  it('グローバルの Object.prototype は汚染されない', async () => {
    await run('"__proto__": {polluted: yes}');
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe('攻撃経路の防御（構造化入力を受け取るホスト向け）', () => {
  const own = (v: Value, k: string): boolean =>
    Object.prototype.hasOwnProperty.call(v as object, k);
  const at = (v: Value, k: string): Value => (v as { [key: string]: Value })[k]!;

  // --- キー：プロトタイプ汚染族 ---
  it('constructor / prototype キーはただのデータで、プロトタイプを汚さない', async () => {
    const r = await run(`
$std.merge:
- a: 1
- constructor:
    prototype:
      polluted: yes
`);
    expect(Object.keys(r as object)).toEqual(['a', 'constructor']);
    expect(own(r, 'constructor')).toBe(true);
    // 実 constructor は隠れず、グローバルも汚れない（eval は .constructor.prototype を歩かない）
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
  });

  // --- キー：継承メソッド名の読み出し族 ---
  it('継承メソッド名を持たないキーとして読むと、関数を返さず missing key で失敗する', async () => {
    // パスアクセス
    await expect(run('$let:\n  m: {a: 1}\n$in: ${m.toString}')).rejects.toThrow(
      /missing key 'toString'/,
    );
    // std.lookup
    await expect(
      run('$std.lookup:\n  in: {a: 1}\n  key: hasOwnProperty'),
    ).rejects.toThrow(/missing key 'hasOwnProperty'/);
  });

  it('own の hasOwnProperty キーがあっても内部の重複検査は破られない', async () => {
    await expect(
      run(`
$collect:
- hasOwnProperty
- hasOwnProperty
$with:
  $fn: k
  $body:
  - key: ${'${k}'}
    value: 1
$into: mapping
`),
    ).rejects.toThrow(/duplicate key in \$collect: hasOwnProperty/);
  });

  // --- キー：直列化・Promise 族（非呼び出しゆえ無害） ---
  it('toJSON / then キーはデータとして素通りし、JSON 化や await を乗っ取らない', async () => {
    const r = await run('toJSON: hijacked\nthen: t\na: 1');
    expect(r).toEqual({ toJSON: 'hijacked', then: 't', a: 1 });
    // toJSON が文字列なので JSON.stringify は乗っ取られない
    expect(JSON.parse(JSON.stringify(r))).toEqual({ toJSON: 'hijacked', then: 't', a: 1 });
    // then が文字列なので thenable にならず、await してもその値のまま
    expect(await Promise.resolve(r)).toEqual({ toJSON: 'hijacked', then: 't', a: 1 });
  });

  // --- 値：関数値族（ユーザー言及の「関数でメソッドを書き換える」核心） ---
  it('閉包はどの位置からも文書の値へ脱出できない', async () => {
    const msg = /a function value cannot escape into the document value/;
    // トップレベル
    await expect(run('handler:\n  $fn: x\n  $body: ${x}')).rejects.toThrow(msg);
    // __proto__ の下のメソッド名へ
    await expect(
      run(`
$std.merge:
- x: 1
- "__proto__":
    toString:
      $fn: _
      $body: pwned
`),
    ).rejects.toThrow(msg);
    // リストの奥
    await expect(
      run('data:\n- ok\n- nested:\n    fn:\n      $fn: x\n      $body: ${x}'),
    ).rejects.toThrow(msg);
  });

  it('ホストが param / op で注入した生の JS 関数も、値へ残れば拒まれる', async () => {
    const msg = /a function value cannot escape into the document value/;
    // Value は関数を含まないので、型を欺いて注入するホストを再現するにはキャストが要る。
    const raw = <T>(v: unknown): T => v as T;
    await expect(
      run('out: {$std.param: p}', { params: { p: raw<Value>(() => 'x') } }),
    ).rejects.toThrow(msg);
    // 一段深く隠しても再帰で捕まえる
    await expect(
      run('out: {$std.param: p}', { params: { p: raw<Value>({ f: () => 1 }) } }),
    ).rejects.toThrow(msg);
    // op の戻り値が関数でも同じ
    await expect(
      run('out: {$host.get: x}', { ops: { 'host.get': raw<() => Value>(() => () => 'x') } }),
    ).rejects.toThrow(msg);
  });
});

describe('失敗位置（メッセージ末尾の (at パス)）', () => {
  it('データの中の `$` 式で失敗すると、その値の位置が付く', async () => {
    await expect(run('server:\n  hosts: [a, b, {$std.range: x}]')).rejects.toThrow(
      '$std.range requires a natural number, got: x (at server.hosts[2])',
    );
  });

  it('位置はキーを `.` で、添字を `[i]` で連ねる', async () => {
    await expect(run('x:\n  y:\n  - p\n  - q: {z: [{$if: 1, $then: a, $else: b}]}')).rejects.toThrow(
      '(at x.y[1].q.z[0])',
    );
  });

  it('文書の形の誤りに位置が付く（未定義参照・キー走査・型の不一致）', async () => {
    await expect(run('server:\n  conf: {$.a.self: 1}')).rejects.toThrow(
      'undefined reference: a (at server.conf)',
    );
    await expect(run('server:\n  x:\n    $let: {a: 1}\n    $in: {$.a.self: 2}')).rejects.toThrow(
      "cannot access key '.self' of a non-mapping value (at server.x)",
    );
    await expect(run('a:\n  b: {$std.merge: {x: 1}}')).rejects.toThrow(
      '$std.merge requires a list of mappings, got: {"x":1} (at a.b)',
    );
  });

  it('捕まらずに境界へ達した失敗作用にも位置が付く', async () => {
    await expect(run('a:\n  b: {$std.fail: boom}')).rejects.toThrow('failure: boom (at a.b)');
    // 失敗作用の経路でも path プロパティに入る（throw の経路と同じ扱い）
    await expect(run('a:\n  b: {$std.fail: boom}')).rejects.toThrow(
      expect.objectContaining({ path: 'a.b' }),
    );
    await expect(run('a:\n  b: {$std.param: nope}')).rejects.toThrow(
      'failure: parameter not provided: nope (at a.b)',
    );
    await expect(run('a:\n  b: {$std.get: nope}')).rejects.toThrow(
      'failure: uninitialized cell: nope (at a.b)',
    );
    await expect(run('a:\n  b: {$std.lookup: {in: {p: 1}, key: q}}')).rejects.toThrow(
      "failure: missing key 'q' (at a.b)",
    );
    await expect(run('a:\n  b:\n    $let: {x: {p: 1}}\n    $in: ${x.q}')).rejects.toThrow(
      "failure: missing key 'q' (at a.b)",
    );
  });

  it('ハンドラに捕まった失敗は値に翻訳されるので、位置は残らない', async () => {
    await expect(run('a:\n  b: {$std.opt: {$std.fail: boom}, $default: ok}')).resolves.toEqual({
      a: { b: 'ok' },
    });
    await expect(
      run(`
a:
  b:
    $in: {$std.fail: boom}
    $with: {std.fail: {$fn: m, $body: "caught \${m}"}}
`),
    ).resolves.toEqual({ a: { b: 'caught boom' } });
  });

  it('ルート（位置が空）ではメッセージを変えない', async () => {
    const p = run('{$std.fail: boom}');
    await expect(p).rejects.toThrow('failure: boom');
    await expect(p).rejects.toThrow(
      expect.objectContaining({ message: 'failure: boom', path: undefined }),
    );
  });

  it('位置は EffectfulYamlError の path にも入る', async () => {
    await expect(run('server:\n  hosts: [a, b, {$std.range: x}]')).rejects.toThrow(
      expect.objectContaining({ path: 'server.hosts[2]' }),
    );
  });

  it('位置は二重に付かない（内側が勝つ）', async () => {
    const e = await run('a:\n  b:\n  - {$std.list: [{$std.range: x}]}').then(
      () => new Error('rejected されなかった'),
      (x: Error) => x,
    );
    expect(e.message.match(/\(at /g)).toHaveLength(1);
    expect(e.message).toContain('(at a.b[0])');
  });

  // ponytail: 位置は出力の値の中の場所なので、最後の文そのものが失敗すればその値は
  // 出力全体であり、位置は空になる（`$do[1]` のような構文のキーは位置に現れない）。
  it('$do の最後の文そのものが失敗すると位置は空になる', async () => {
    await expect(run('$do:\n- a\n- {$std.range: x}')).rejects.toThrow(
      '$std.range requires a natural number, got: x',
    );
    await expect(run('$do:\n- a\n- {$std.range: x}')).rejects.toThrow(
      expect.objectContaining({ path: undefined }),
    );
  });
});

describe('位置が素通しになる経路', () => {
  it('$do の最後の文はそのまま出力になるので、その中のデータで位置が伸びる', async () => {
    await expect(run('$do:\n- a\n- server:\n    hosts: [b, {$std.range: x}]')).rejects.toThrow(
      '(at server.hosts[1])',
    );
  });

  it('$let の $in の本体で位置が伸びる', async () => {
    await expect(run('$let: {x: 1}\n$in:\n  a:\n    b: {$std.range: x}')).rejects.toThrow(
      '(at a.b)',
    );
  });

  it('$std.state の $in の本体で位置が伸びる', async () => {
    await expect(run('$std.state: {n: 0}\n$in:\n  a: {$std.range: x}')).rejects.toThrow('(at a)');
  });

  it('$if の $then と $else で位置が伸びる', async () => {
    await expect(run('$if: true\n$then:\n  a: {$std.range: x}\n$else: null')).rejects.toThrow(
      '(at a)',
    );
    await expect(run('$if: false\n$then: null\n$else:\n  b: {$std.range: x}')).rejects.toThrow(
      '(at b)',
    );
  });

  it('$std.opt の本体で位置が伸びる（捕捉できないエラーはそのまま出る）', async () => {
    await expect(run('$std.opt:\n  a: {$std.range: x}\n$default: fallback')).rejects.toThrow(
      '(at a)',
    );
  });

  it('$std.opt と $std.param の $default で位置が伸びる（失敗時の値がそのまま出力になる）', async () => {
    await expect(
      run('a:\n  $std.opt: {$std.fail: boom}\n  $default:\n    b: {$std.range: q}'),
    ).rejects.toThrow('(at a.b)');
    await expect(
      run('a:\n  $std.param: nope\n  $default:\n    b: {$std.range: q}'),
    ).rejects.toThrow('(at a.b)');
  });

  it('前置きを持つマッピングのデータのキーで位置が伸びる', async () => {
    await expect(run('$let: {x: 1}\nserver:\n  hosts: [a, {$std.range: q}]')).rejects.toThrow(
      '(at server.hosts[1])',
    );
  });
});

describe('位置が凍る経路', () => {
  it('$std.list の本体は値の形を変えるので凍る', async () => {
    await expect(run('k:\n  $std.list:\n    a: {$std.range: x}')).rejects.toThrow(
      expect.objectContaining({ path: 'k' }),
    );
  });

  it('$let の束縛の右辺は凍る', async () => {
    await expect(run('k:\n  $let:\n    x:\n      a: {$std.range: q}\n  $in: 1')).rejects.toThrow(
      expect.objectContaining({ path: 'k' }),
    );
  });

  it('return の節を持つ $with の本体は凍る', async () => {
    await expect(
      run(`
k:
  $in:
    a: {$std.range: x}
  $with:
    return: {$fn: v, $body: "\${v}"}
`),
    ).rejects.toThrow(expect.objectContaining({ path: 'k' }));
  });

  it('$fn の本体は凍る', async () => {
    await expect(
      run(`
k:
  $let:
    f: {$fn: y, $body: {a: {$std.range: x}}}
  $in: {$.f: 1}
`),
    ).rejects.toThrow(expect.objectContaining({ path: 'k' }));
  });

  it('凍った位置の内側の $in は伸びない', async () => {
    await expect(
      run(`
k:
  $std.list:
    $let: {x: 1}
    $in:
      a: {$std.range: q}
`),
    ).rejects.toThrow(expect.objectContaining({ path: 'k' }));
  });
});
