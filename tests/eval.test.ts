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

describe('選択の基本形（grammar/examples.md）', () => {
  it('末尾が $std.each なら 18 要素になる', async () => {
    await expect(
      run(`
$handler: \${std.list}
$in:
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
$handler: \${std.list}
$in:
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
$handler: \${std.list}
$in:
  $do:
  - $let:
      e: {$std.each: {web: 80, db: 5432}}
  - \${e.key}
`),
    ).resolves.toEqual(['web', 'db']);
  });

  it('リストの要素は合成なので、選択は外側のブロック全体を分岐させる', async () => {
    await expect(
      run('{$handler: "${std.list}", $in: {$do: [[1, {$std.each: [a, b]}]]}}'),
    ).resolves.toEqual([
      [1, 'a'],
      [1, 'b'],
    ]);
  });

  it('演算の引数も合成なので、$std.each の入れ子が平坦化される', async () => {
    await expect(
      run('{$handler: "${std.list}", $in: {$std.each: {$std.each: [[1, 2], [3, 4]]}}}'),
    ).resolves.toEqual([1, 2, 3, 4]);
  });

  it('データ文脈では最も外側の $ 式だけが境界になる（$do の中との対比）', async () => {
    // 上の $do のテストでは同じ字面がブロック全体を分岐させる。
    // データ文脈では選択のハンドラ自身が境界なので、収集はその中で閉じる。
    await expect(
      run('x: [1, {$handler: "${std.list}", $in: {$std.each: [a, b]}}]'),
    ).resolves.toEqual({
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
$handler: \${std.list}
$in:
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
    await expect(run('{$handler: "${std.list}", $in: {$std.where: true}}')).resolves.toEqual([
      null,
    ]);
    await expect(run('{$handler: "${std.list}", $in: {$std.where: false}}')).resolves.toEqual([]);
  });

  it('打ち切りは展開のとおり std.each の節が捕捉する', async () => {
    await expect(
      run(`
$handler:
  std.each:
    $fn: xs
    $body: caught
$in:
  $do:
  - $std.where: false
  - after
`),
    ).resolves.toBe('caught');
  });

  it('std.where は節の名前に書けない（関数であり演算ではないため）', async () => {
    // 節の名前は環境で解決され、解決先が演算でなければエラーである。
    await expect(
      run(`
$handler:
  std.where:
    $fn: _
    $body: caught
$in:
  $do:
  - $std.where: false
  - after
`),
    ).rejects.toThrow("$handler clause 'std.where' must name an operation, got: <function>");
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
$handler:
  std.fail:
    $fn: msg
    $body: caught \${msg}
$in: {$std.param: nope}
`),
    ).resolves.toBe('caught parameter not provided: nope');
    await expect(run('{$std.param: nope, $default: null}')).resolves.toBe(null);
  });

  it('{$std.param: 名前, $default: 式} は std.fail 節への展開と等価である', async () => {
    // 展開: {$std.param: 名前} を $handler で包み、std.fail の節で $default の式を返す。
    const expanded = `
$handler:
  std.fail:
    $fn: _
    $body: 5432
$in: {$std.param: port}
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
      run('{$handler: "${std.list}", $in: {$std.param: x, $default: {$std.each: [1, 2]}}}'),
    ).resolves.toEqual([1, 2]);
  });

  it('grammar/examples.md（パラメータと条件分岐）', async () => {
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
$handler: \${std.list}
$in:
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
    // 仕様の展開では、この失敗は std.state の std.get の節の本体（`${hits[0]}`）が起こす。
    // 節の本体の作用はそのハンドラ自身ではなく外側で処理されるので、
    // 捕まえられるのは std.state のハンドラを包む側だけである。
    await expect(
      run(`
$handler: {$std.state: {}}
$in: {$std.get: nope}
$default: null
`),
    ).resolves.toBe(null);
    // 内側に置いた $default は、状態のハンドラより内側なので捕まえられない。
    await expect(
      run(`
$handler: {$std.state: {}}
$in:
  $std.get: nope
  $default: null
`),
    ).rejects.toThrow('failure: uninitialized cell: nope');
  });

  it('内側の std.state のハンドラは外の状態に触れない（スコープの隔離）', async () => {
    await expect(
      run(`
$do:
- $std.set: {n: 100}
- $let:
    inner:
      $handler: {$std.state: {n: 0}}
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
$handler: {$std.state: {n: 0}}
$in:
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
`),
    ).resolves.toEqual(['a10', 'b11']);
  });

  it('分岐点で分かれる: 各分岐が選択時点の状態を引き継ぐ', async () => {
    await expect(
      run(`
$handler: \${std.list}
$in:
  $handler: {$std.state: {n: 0}}
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
$handler: \${std.list}
$in:
  $do:
  - $let:
      x: {$std.each: [a, b]}
  - $handler: {$std.state: {n: 0}}
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
$handler: \${std.list}
$in:
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

  it('{$std.state: 初期値} は部分適用の呼び出しなので、$let で束縛して再利用できる', async () => {
    // std.state は初期値と本体の閉包をとるカリー化された関数であり、{$std.state: I} の値は
    // 本体の閉包を待つ関数である。束縛して $handler: ${名前} に置けば同じハンドラを再利用でき、
    // 立てるたびに状態は初期値から始まる。
    await expect(
      run(`
$do:
- $let:
    memo: {$std.state: {n: 0}}
- a:
    $handler: \${memo}
    $in:
      $do:
      - $std.set: {n: 1}
      - {$std.get: n}
  b:
    $handler: \${memo}
    $in: {$std.get: n}
`),
    ).resolves.toEqual({ a: 1, b: 0 });
  });
});

describe('ハンドラを立てる関数（std.list / std.mapping / std.first）', () => {
  it('std.list は全分岐を集める', async () => {
    await expect(
      run(`
sizes:
  $handler: \${std.list}
  $in:
    $do:
    - $let:
        n: {$std.each: [1, 2, 3]}
    - \${n * 10}
`),
    ).resolves.toEqual({ sizes: [10, 20, 30] });
  });

  it('選択が無ければ要素 1 のリストになる', async () => {
    await expect(run('{$handler: "${std.list}", $in: 42}')).resolves.toEqual([42]);
  });

  it('直接の呼び出し {$std.list: {$fn: _, $body: 本体}} は $handler: ${std.list} と同じ値になる', async () => {
    // std.list は本体の閉包を受け取る関数であり、$handler はその引数に本体の閉包を渡す。
    // 二つの書き方は同じ適用に帰着する。
    const inner = `
    $do:
    - $let:
        n: {$std.each: [1, 2, 3]}
    - \${n * 10}
`;
    const viaHandler = await run(`
$handler: \${std.list}
$in:${inner}`);
    const viaCall = await run(`
$std.list:
  $fn: _
  $body:${inner}`);
    expect(viaCall).toEqual(viaHandler);
    expect(viaCall).toEqual([10, 20, 30]);
  });

  it('std.mapping は {key, value} を集める', async () => {
    await expect(
      run(`
$handler: \${std.mapping}
$in:
  $do:
  - $let:
      e: {$std.each: {web: 80, db: 5432}}
  - key: svc-\${e.key}
    value: \${e.value}
`),
    ).resolves.toEqual({ 'svc-web': 80, 'svc-db': 5432 });
  });

  it('std.first は失敗しなかった最初の分岐', async () => {
    await expect(
      run(`
log_level:
  $handler: \${std.first}
  $in:
    $do:
    - $let:
        v: {$std.each: [{$std.param: log_level, $default: null}, info]}
    - $std.where: \${v != null}
    - \${v}
`),
    ).resolves.toEqual({ log_level: 'info' });
  });

  it('std.first は渡されたパラメータを優先する', async () => {
    await expect(
      run(
        `
log_level:
  $handler: \${std.first}
  $in:
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

  it('std.first は最初の成功より後の分岐を評価しない（作用も起こさない）', async () => {
    const logs: Value[] = [];
    await expect(
      run(
        `
$handler: \${std.first}
$in:
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

  it('全分岐が打ち切られれば std.first は失敗する', async () => {
    await expect(
      run(`
$handler: \${std.first}
$in:
  $do:
  - $let:
      v: {$std.each: [1, 2]}
  - $std.where: false
  - \${v}
`),
    ).rejects.toThrow(EffectfulYamlError);
  });

  it('std.list は失敗を処理しない', async () => {
    await expect(run('{$handler: "${std.list}", $in: {$std.fail: boom}}')).rejects.toThrow(/boom/);
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
$handler: \${std.list}
$in:
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

  it("部分適用の閉包は $std.collect の 'with' にも置ける", async () => {
    await expect(
      run(`
$do:
- $let:
    scaled:
      $fn: [k, x]
      $body:
      - \${k * x}
    tripled: {$.scaled: 3}
- $std.collect:
    in: [1, 2, 3]
    with: \${tripled}
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

  it('$handler の節は一引数で呼ばれるので、多引数の節は閉包が値になり脱出のエラーに至る', async () => {
    await expect(
      run(`
$handler:
  std.fail:
    $fn: [msg, extra]
    $body: \${msg}
$in: {$std.fail: boom}
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

  it('空区画・添字は invalid call path（名前は 名前(.名前)* に限る）', async () => {
    await expect(run('$..a: 1')).rejects.toThrow(/invalid call path/);
    await expect(run('$.a.: 1')).rejects.toThrow(/invalid call path/);
    await expect(run('$.a[0]: 1')).rejects.toThrow(/invalid call path/);
  });
});

describe('$handler / $in / $resume', () => {
  it('失敗を捕捉して既定値に置き換える', async () => {
    const logs: Value[] = [];
    await expect(
      run(
        `
port:
  $handler:
    std.fail:
      $fn: msg
      $body:
        $do:
        - $std.log: \${msg}
        - 5432
  $in:
    $do:
    - $let:
        p: {$std.param: port, $default: 0}
    - $if: \${p <= 0}
      $then:
        $std.fail: invalid port \${p}
      $else: \${p}
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
$handler:
  std.log:
    $fn: msg
    $body:
      $do:
      - $std.log: 'app: \${msg}'
      - {$resume: null}
$in:
  $do:
  - $std.log: hello
  - 42
`,
        { onLog: (v) => logs.push(v) },
      ),
    ).resolves.toBe(42);
    expect(logs).toEqual(['app: hello']);
  });

  it('$resume の多重呼び出しで std.list を自作できる', async () => {
    await expect(
      run(`
$handler:
  std.each:
    $fn: xs
    $body:
      $handler: \${std.list}
      $in:
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
$in:
  $do:
  - $let:
      x: {$std.each: [1, 2]}
      y: {$std.each: [10, 20]}
  - \${x + y}
`),
    ).resolves.toEqual([11, 21, 12, 22]);
  });

  it('組み込みの std.list も同じ結果になる', async () => {
    await expect(
      run(`
$handler: \${std.list}
$in:
  $do:
  - $let:
      x: {$std.each: [1, 2]}
      y: {$std.each: [10, 20]}
  - \${x + y}
`),
    ).resolves.toEqual([11, 21, 12, 22]);
  });

  it('$resume を書けない位置は評価前に拒まれる', async () => {
    const msg = '$resume is only allowed inside a $handler clause';
    // 境界に単独で置いた $resume
    await expect(run('{$resume: 1}')).rejects.toThrow(msg);
    // return 節の本体
    await expect(
      run(`
$handler:
  return:
    $fn: v
    $body: {$resume: "\${v}"}
$in: 1
`),
    ).rejects.toThrow(msg);
    // ハンドラの本体
    await expect(
      run(`
$handler:
  std.fail: {$fn: _, $body: caught}
$in: {$resume: 1}
`),
    ).rejects.toThrow(msg);
    // ハンドラの外にある $fn の本体（節から呼ばれても、書いた位置が節の外なら拒まれる）
    await expect(
      run(`
$do:
- $let:
    k:
      $fn: v
      $body: {$resume: "\${v}"}
- $handler:
    std.fail: {$fn: _, $body: {$.k: 1}}
- {$std.fail: boom}
`),
    ).rejects.toThrow(msg);
  });
});

describe('境界に達した選択', () => {
  it('選ばれなかった分岐の選択は起きない（$else 側が選ばれれば値は 42）', async () => {
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
  $handler: \${std.list}
  $in:
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
$handler: \${std.list}
$in:
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

  it('ホストが与えていない束縛の呼び出しは評価前に undefined reference で拒まれる', async () => {
    // 0.13 では名前空間は環境なので、ホストの演算も初期環境の束縛である。
    // 束縛が無ければ、演算の実装の有無ではなく参照の未定義として拒まれる。
    await expect(run('password: {$vault.read: secret/db/password}')).rejects.toThrow(
      /undefined reference: vault/,
    );
  });

  it('ホストの演算は非同期でもよい', async () => {
    await expect(
      run('password: {$vault.read: secret/db/password}', {
        ops: { 'vault.read': async (k) => `value of ${String(k)}` },
      }),
    ).resolves.toEqual({ password: 'value of secret/db/password' });
  });

  it('ホストの演算は $handler の節が横取りでき、そのとき実装は走らない', async () => {
    let calls = 0;
    await expect(
      run(
        `
$handler:
  vault.read:
    $fn: key
    $body: handled-\${key}
$in: {$vault.read: db/password}
`,
        {
          ops: {
            'vault.read': (k) => {
              calls += 1;
              return `value of ${String(k)}`;
            },
          },
        },
      ),
    ).resolves.toBe('handled-db/password');
    expect(calls).toBe(0);
  });
});

describe('fold（std.state + std.list による畳み込み）', () => {
  it('6 になる', async () => {
    await expect(
      run(`
$do:
- $let:
    fold:
      $fn: arg
      $body:
        $handler:
          $std.state:
            acc: \${arg.init}
        $in:
          $do:
          - $handler: \${std.list}
            $in:
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

describe('std の関数 std.collect', () => {
  it("'with' の結果リストを文書順に連結する（'into' 省略時は list）", async () => {
    await expect(
      run(`
$std.collect:
  in: [1, 2, 3]
  with:
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
$std.collect:
  in: [1, 2, 3, 4]
  with:
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
$std.collect:
  in: {web: 80, db: 5432}
  with:
    $fn: e
    $body:
    - \${e.key}=\${e.value}
`),
    ).resolves.toEqual(['web=80', 'db=5432']);
  });

  it('into: mapping は {key, value} のエントリを集めたマッピングになる', async () => {
    const result = await run(`
$std.collect:
  in: {web: 80, db: 5432}
  with:
    $fn: e
    $body:
    - key: svc-\${e.key}
      value: \${e.value}
  into: mapping
`);
    expect(result).toEqual({ 'svc-web': 80, 'svc-db': 5432 });
    expect(Object.keys(result as object)).toEqual(['svc-web', 'svc-db']);
  });

  it('空の対象の値は、list なら空リスト、mapping なら空マッピング', async () => {
    await expect(run('{$std.collect: {in: [], with: {$fn: x, $body: []}}}')).resolves.toEqual([]);
    await expect(
      run('{$std.collect: {in: {}, with: {$fn: x, $body: []}, into: mapping}}'),
    ).resolves.toEqual({});
  });

  it("契約違反はエラー：'with' の結果がリストでない", async () => {
    await expect(run('{$std.collect: {in: [1], with: {$fn: x, $body: 5}}}')).rejects.toThrow(
      /\$std\.collect requires the 'with' function to return a list/,
    );
  });

  it('契約違反はエラー：into: mapping のエントリが {key, value} でない', async () => {
    await expect(
      run(`
$std.collect:
  in: [1]
  with:
    $fn: x
    $body:
    - {k: 1}
  into: mapping
`),
    ).rejects.toThrow(/exactly the keys 'key' and 'value'/);
    await expect(
      run(`
$std.collect:
  in: [1]
  with:
    $fn: x
    $body:
    - {key: 1, value: 2}
  into: mapping
`),
    ).rejects.toThrow(/\$std\.collect key must be a string/);
  });

  it('契約違反はエラー：into: mapping のキーが重複する', async () => {
    await expect(
      run(`
$std.collect:
  in: [1, 2]
  with:
    $fn: x
    $body:
    - key: same
      value: \${x}
  into: mapping
`),
    ).rejects.toThrow(/duplicate key in \$std\.collect: same/);
  });

  it('対象がリストでもマッピングでもなければエラー', async () => {
    await expect(run('{$std.collect: {in: 3, with: {$fn: x, $body: []}}}')).rejects.toThrow(
      /\$std\.collect 'in' requires a list or mapping/,
    );
  });

  it("'into' は list か mapping のどちらかでなければならない", async () => {
    await expect(
      run('{$std.collect: {in: [], with: {$fn: x, $body: []}, into: set}}'),
    ).rejects.toThrow(/\$std\.collect 'into' must be 'list' or 'mapping'/);
  });

  it("'with' は省略できない", async () => {
    await expect(run('{$std.collect: {in: []}}')).rejects.toThrow(
      /\$std\.collect requires 'with'/,
    );
  });

  it('引数は {in, with, into} のマッピングでなければならない', async () => {
    await expect(run('{$std.collect: [1, 2]}')).rejects.toThrow(
      /\$std\.collect requires a mapping \{in, with, into\}/,
    );
  });

  it('std.collect は関数なので作用を持たず、節の名前にも書けない', async () => {
    // 節の名前は環境で解決され、解決先が演算でなければエラーである。
    // std.collect の作用は引数の式と 'with' の関数本体の作用だけであり、捕捉する対象を持たない。
    await expect(
      run(`
$handler:
  std.collect:
    $fn: xs
    $body: intercepted
$in:
  $std.collect:
    in: [1, 2]
    with:
      $fn: x
      $body:
      - \${x}
`),
    ).rejects.toThrow("$handler clause 'std.collect' must name an operation, got: <function>");
  });

  it('対象と関数本体の作用は周囲へ合流する（呼び出しと同じ規則）', async () => {
    // 関数本体の $std.each は std.collect に堰き止められず、外側の std.list が集める。
    await expect(
      run(`
$handler: \${std.list}
$in:
  $std.collect:
    in: [1, 2]
    with:
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
- $std.collect:
    in: [a, b, c]
    with:
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

describe('std.range', () => {
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

  it('std.range は選択を起こさないので、ハンドラ無しで境界に置ける', async () => {
    // 値のリストは std.range 自身の値である。
    await expect(run('a: {$std.range: 3}')).resolves.toEqual({ a: [0, 1, 2] });
  });

  it('std.range は関数なので、節の名前には書けない', async () => {
    // 0.12 では登録演算として演算パイプラインに乗っていたが、0.13 では std の関数である。
    await expect(
      run(`
$handler:
  std.range:
    $fn: n
    $body:
      $resume: [x, y]
$in: {$std.range: 3}
`),
    ).rejects.toThrow("$handler clause 'std.range' must name an operation, got: <function>");
  });

  it('ホストの演算はハンドラで差し替えられる（演算である以上、意味は最も近いハンドラが選ぶ）', async () => {
    // std の演算に限らず、ホストが与えた任意の演算の名前で差し替えられる。
    await expect(
      run(
        `
$handler:
  str.upper:
    $fn: s
    $body: shouted-\${s}
$in: {$str.upper: abc}
`,
        { ops: { 'str.upper': (s) => String(s).toUpperCase() } },
      ),
    ).resolves.toBe('shouted-abc');
  });
});

describe('欠落の失敗作用化', () => {
  it('存在しないキーのパスアクセスは std.fail を起こす（メッセージは missing key）', async () => {
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

  it('$default: null は失敗を null に変える', async () => {
    await expect(
      run(`
$do:
- $let: {r: {a: 1}}
- present: '\${r.a}'
  missing: {$do: ['\${r.b}'], $default: null}
`),
    ).resolves.toEqual({ present: 1, missing: null });
  });

  it('打ち切りの定型（$default: {$std.where: false}）は失敗を包囲する選択の打ち切りに変える', async () => {
    await expect(
      run(`
$handler: \${std.list}
$in:
  $do:
  - $let:
      row: {$std.each: [{a: 1}, {}, {a: 3}]}
  - \${row.a}
  $default: {$std.where: false}
`),
    ).resolves.toEqual([1, 3]);
  });

  it('$handler で捕まえれば任意の値に翻訳できる', async () => {
    await expect(
      run(`
$handler:
  std.fail:
    $fn: msg
    $body: 'recovered: \${msg}'
$in:
  $do:
  - $let: {r: {}}
  - \${r.b}
`),
    ).resolves.toBe("recovered: missing key 'b'");
  });

  it('束縛名の未定義・非コンテナの走査・型の不一致・0 除算はハードエラーのまま', async () => {
    const hard = [
      ['{$do: ["${nope}"], $default: null}', /undefined reference: nope/],
      ['$do: [{$let: {x: 1}}, {$do: ["${x.y}"], $default: null}]', /cannot access key '\.y' of a non-mapping/],
      ['$do: [{$let: {x: {}}}, {$do: ["${x[0]}"], $default: null}]', /cannot access index \[0\] of a non-list/],
      ['{$do: ["${1 + \'a\'}"], $default: null}', /requires a numeric operand/],
      ['{$do: ["${1 / 0}"], $default: null}', /division by zero/],
    ] as const;
    for (const [yaml, pattern] of hard) {
      // $default を添えても捕まらないことが「失敗作用ではない」ことの証拠。
      await expect(run(yaml)).rejects.toThrow(pattern);
    }
  });

  it('裸の参照は純粋なので、パスをたどる参照だけが std.fail を作用に加える', async () => {
    // std.first は std.fail を処理するので、パス参照の失敗が最初の分岐を捨てる。
    await expect(
      run(`
$handler: \${std.first}
$in:
  $do:
  - $let:
      row: {$std.each: [{}, {a: 2}]}
  - \${row.a}
`),
    ).resolves.toBe(2);
  });
});

describe('$default の展開（std.fail の節への糖衣）', () => {
  it('{X ∪ {$default: 式}} は X を std.fail の節で包む展開と等価である', async () => {
    const sugar = await run(`
$do:
- $let: {r: {}}
- \${r.b}
$default: null
`);
    const expanded = await run(`
$handler:
  std.fail:
    $fn: _
    $body: null
$in:
  $do:
  - $let: {r: {}}
  - \${r.b}
`);
    expect(sugar).toEqual(expanded);
    expect(sugar).toBe(null);
  });

  it('$default の式が起こす作用は、展開の $handler の外側で処理される', async () => {
    // 節が $resume を呼ばずに式へ達するので、失敗した時点で本体は打ち切られる。
    // 節の本体の作用はこのハンドラでは処理されないので、$std.where の打ち切りは
    // 包囲する std.list に届き、分岐ごと打ち切られる。
    const sugar = await run(`
$handler: \${std.list}
$in:
  $do:
  - $let:
      row: {$std.each: [{a: 1}, {}]}
  - \${row.a}
  $default: {$std.where: false}
`);
    const expanded = await run(`
$handler: \${std.list}
$in:
  $handler:
    std.fail:
      $fn: _
      $body: {$std.where: false}
  $in:
    $do:
    - $let:
        row: {$std.each: [{a: 1}, {}]}
    - \${row.a}
`);
    expect(sugar).toEqual(expanded);
    expect(sugar).toEqual([1]);
  });

  it('$default は $let を頭に持つマッピングにも添えられる（頭と本体をまとめて包む）', async () => {
    await expect(
      run(`
$let:
  m: {}
$in: \${m.nope}
$default: fallback
`),
    ).resolves.toBe('fallback');
    await expect(
      run(`
$let:
  m: {a: 1}
$in: \${m.a}
$default: fallback
`),
    ).resolves.toBe(1);
  });

  it('$default は呼び出しの主形にも添えられる（$std.lookup の欠落を埋める）', async () => {
    await expect(
      run(`
$std.lookup: {in: {a: 1}, key: nope}
$default: fallback
`),
    ).resolves.toBe('fallback');
    await expect(
      run(`
$std.lookup: {in: {a: 1}, key: a}
$default: fallback
`),
    ).resolves.toBe(1);
  });

  it('$default の式は $ 式の外側にあるので、頭が導入する束縛を見られない', async () => {
    // 展開は {$handler: {std.fail: 節}, $in: X} であり、既定値の式は節の本体、すなわち X の外である。
    await expect(
      run(`
$let:
  m: {}
$in: \${m.nope}
$default: \${m}
`),
    ).rejects.toThrow(/undefined reference: m/);
  });
});

describe('$default（どの $ 式にも添えられる補助キー）', () => {
  it('欠落したパスアクセスの失敗は $default の値になる', async () => {
    await expect(
      run(`
$do:
- $let: {m: {}}
- $do: ['\${m.nope}']
  $default: fallback
`),
    ).resolves.toBe('fallback');
  });

  it('成功時は本体の値になり、$default は評価されない', async () => {
    const logs: Value[] = [];
    await expect(
      run(
        `
$do: [ok]
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
- $do: ['\${m.nope}']
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
- $do: ['\${m.nope}']
  $default: {$std.fail: still missing}
`),
    ).rejects.toThrow('failure: still missing');
  });

  it('$default: {} のような空マッピングも既定値にできる', async () => {
    await expect(
      run(`
$do:
- $let: {m: {}}
- $do: ['\${m.nope}']
  $default: {}
`),
    ).resolves.toEqual({});
  });

  it('未渡しパラメータの失敗も捕捉できる', async () => {
    await expect(run('{$std.param: nope, $default: 5}')).resolves.toBe(5);
  });

  it('どの主キーにも添えられる（0.12 で $default を取らなかった主キーにも）', async () => {
    const logs: Value[] = [];
    await expect(run('{$std.log: x, $default: 1}', { onLog: (v) => logs.push(v) })).resolves.toBe(
      null,
    );
    expect(logs).toEqual(['x']);
    await expect(
      run('{$handler: "${std.list}", $in: {$std.fail: boom}, $default: fallback}'),
    ).resolves.toBe('fallback');
    // 添える先は `$` 式でなければならない（データのマッピングには添えられない）。
    await expect(run('{a: 1, $default: 2}')).rejects.toThrow(/\$ key mixed with plain keys: a/);
  });

  it('本体が成功すれば $default は評価されず、その中の選択も起きない（$std.param の $default と同じ）', async () => {
    await expect(run('{$do: [ok], $default: {$std.each: [1, 2]}}')).resolves.toBe('ok');
  });

  it('ホスト演算の失敗通知（OperationFailure）も $default で埋められる', async () => {
    await expect(
      run('{$x.op: a, $default: d}', {
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

  it('$default と合成すると既定値になる', async () => {
    await expect(
      run(`
$do:
- $let:
    table: {a: 1}
- $std.lookup:
    in: \${table}
    key: x
  $default: fallback
`),
    ).resolves.toBe('fallback');
  });

  it('std.list の中で打ち切りの定型と合成すると、無いキーの分岐だけが落ちる', async () => {
    await expect(
      run(`
$handler: \${std.list}
$in:
  $do:
  - $let:
      row:
        $std.each:
        - {t: {a: 1}, k: a}
        - {t: {a: 1}, k: x}
        - {t: {a: 1}, k: a}
  - $std.lookup:
      in: \${row.t}
      key: \${row.k}
    $default: {$std.where: false}
`),
    ).resolves.toEqual([1, 1]);
  });

  it("'in' がマッピングでなければエラーになり、$default でも捕捉できない（形の誤り）", async () => {
    await expect(run('{$std.lookup: {in: [1, 2, 3], key: a}}')).rejects.toThrow(
      /'in' must be a mapping/,
    );
    await expect(
      run('{$std.lookup: {in: [1, 2, 3], key: a}, $default: null}'),
    ).rejects.toThrow(/'in' must be a mapping/);
  });

  it('key が文字列でなければエラーになり、$default でも捕捉できない（形の誤り）', async () => {
    await expect(run('{$std.lookup: {in: {a: 1}, key: 1}}')).rejects.toThrow(
      /\$std\.lookup key must be a string/,
    );
    await expect(
      run('{$std.lookup: {in: {a: 1}, key: 1}, $default: null}'),
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

  it('展開の中の選択は std.first が処理し尽くすので外へ出ない', async () => {
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

  it('引数がリストでない・要素がマッピングでないのは形の誤りで、$default でも捕捉できない', async () => {
    await expect(run('{$std.merge: {a: 1}}')).rejects.toThrow(
      /\$std\.merge requires a list of mappings/,
    );
    await expect(run('{$std.merge: {a: 1}, $default: null}')).rejects.toThrow(
      /\$std\.merge requires a list of mappings/,
    );
    await expect(run('{$std.merge: [1, 2]}')).rejects.toThrow(
      /\$std\.merge element must be a mapping/,
    );
    await expect(run('{$std.merge: [1, 2], $default: null}')).rejects.toThrow(
      /\$std\.merge element must be a mapping/,
    );
  });

  it('引数の中に $std.each があると merge 全体が分岐する（値は各分岐の merge 結果）', async () => {
    await expect(
      run(`
$handler: \${std.list}
$in:
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

  it('選択を含まない $std.merge はハンドラ無しで境界に置ける', async () => {
    await expect(run('a: {$std.merge: [{x: 1}, {y: 2}]}')).resolves.toEqual({
      a: { x: 1, y: 2 },
    });
  });

  it('std.merge は関数なので、節の名前には書けない（捕捉する作用を持たない）', async () => {
    await expect(
      run(`
$handler:
  std.merge:
    $fn: _
    $body: caught
$in:
  $std.merge:
  - {a: 1}
  - {b: 2}
`),
    ).rejects.toThrow("$handler clause 'std.merge' must name an operation, got: <function>");
  });

  it('引数の要素の値の中の $std.fail は伝播し、$default で捕捉できる', async () => {
    await expect(
      run(`
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
$handler:
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
$in:
  $std.get: n
`),
    ).resolves.toBe(42);
  });

  it('継続の再開結果を $let で値として束縛し、後で適用できる（std.state の展開の形）', async () => {
    // 仕様の std.state の展開そのもの：節が状態変換関数を返し、再開結果もまた
    // 状態変換関数なので、それを現在の状態に適用して続ける。
    // ここは読み出し専用の一セルに縮めた最小形で、21 を読んで 2 倍する。
    await expect(
      run(`
$do:
- $let:
    f:
      $handler:
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
      $in:
        $do:
        - $let:
            v: {$std.get: acc}
        - \${v * 2}
- {$.f: 21}
`),
    ).resolves.toBe(42);
  });

  it('std.list は仕様の展開（std.each / return の節）と同じ値になる', async () => {
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
$in:${body}`);
    const builtin = await run(`
$handler: \${std.list}
$in:${body}`);
    expect(expanded).toEqual(builtin);
    expect(builtin).toEqual([
      [1, 2],
      [1, 3],
      [2, 3],
    ]);
  });

  it('閉包経由でも多重再開できる（std.list を自作する）', async () => {
    await expect(
      run(`
$handler:
  std.each:
    $fn: xs
    $body:
      $do:
      - $let:
          k:
            $fn: v
            $body:
              $resume: \${v}
      - $std.collect:
          in: \${xs}
          with:
            $fn: e
            $body:
              $.k: \${e}
  return:
    $fn: v
    $body:
    - \${v}
$in:
  $do:
  - $let:
      x: {$std.each: [1, 2]}
  - \${x * 10}
`),
    ).resolves.toEqual([10, 20]);
  });
});

describe('予約キーと名前空間', () => {
  it('予約されていないドットなしキーは「予約されていない $ キー」のエラーになる', async () => {
    // 0.13 の予約キーは 12 個（$do $let $in $if $then $else $fn $body $for $handler $resume $default）。
    // 0.12 の $with・$collect・$into・$std.opt の綴りも、std の名前も、どれも予約されていない。
    const names = [
      'with', 'collect', 'into', 'opt', 'handle', 'each', 'where', 'param', 'get', 'set', 'log',
      'fail', 'list', 'first', 'mapping', 'state', 'op', 'pipe', 'through', 'foo',
    ];
    for (const name of names) {
      await expect(run(`{$${name}: x}`)).rejects.toThrow(`unreserved $ key: $${name}`);
    }
  });

  it('$.return は呼び出せない（return はハンドラの節名として予約されている）', async () => {
    await expect(run('{$.return: 1}')).rejects.toThrow(
      'return is reserved: $.return is not callable',
    );
    await expect(run('{$.return.x: 1}')).rejects.toThrow(
      'return is reserved: $.return is not callable',
    );
    // 束縛としての return と ${return} の参照は妨げない。
    await expect(run('{$let: {return: 1}, $in: "${return}"}')).resolves.toBe(1);
  });

  it('$in と $default は、それを取る主キーに付随するときだけ有効', async () => {
    await expect(run('{$in: 1}')).rejects.toThrow(/auxiliary \$ key without a main key/);
    await expect(run('{$default: 1}')).rejects.toThrow(/auxiliary \$ key without a main key/);
    await expect(run('{$do: [], $in: 1}')).rejects.toThrow(/\$do does not accept \$in/);
    // $default はどの $ 式にも添えられるが、$in は頭の本体なので呼び出しには添えられない。
    await expect(run('{$std.log: x, $in: 1}')).rejects.toThrow(/\$std\.log does not accept \$in/);
  });

  it('$in を省いた頭（$let / $for / $handler）は $do の文の位置でだけ書ける', async () => {
    await expect(run('{$for: {x: [1, 2]}}')).rejects.toThrow(
      /\$for without \$in is only allowed as a statement of \$do/,
    );
    await expect(run('{$handler: {$std.state: {}}}')).rejects.toThrow(
      /\$handler without \$in is only allowed as a statement of \$do/,
    );
    await expect(run('{$handler: {std.fail: {$fn: m, $body: x}}}')).rejects.toThrow(
      /\$handler without \$in is only allowed as a statement of \$do/,
    );
  });

  it('ホストは std. 名前空間に演算も関数も登録できない', async () => {
    await expect(run('x: 1', { ops: { 'std.each': () => null } })).rejects.toThrow(
      /host cannot register an operation in the std namespace: \$std\.each/,
    );
    await expect(run('x: 1', { ops: { 'std.myop': () => null } })).rejects.toThrow(
      /host cannot register an operation in the std namespace/,
    );
    await expect(run('x: 1', { functions: { 'std.myfn': () => null } })).rejects.toThrow(
      /host cannot register a function in the std namespace: \$std\.myfn/,
    );
  });

  it('ホストの名前は 2 区画以上のドット付きで、演算と関数を兼ねられない', async () => {
    await expect(run('x: 1', { ops: { foo: () => null } })).rejects.toThrow(
      /host operation name must be a dotted path of names \(binding\.key\): foo/,
    );
    await expect(
      run('x: 1', { ops: { 'a.b': () => null }, functions: { 'a.b': () => null } }),
    ).rejects.toThrow(/host name registered both as an operation and as a function: a\.b/);
  });

  it('$handler の節名はパスか裸のローカル名か return でなければならない', async () => {
    // 裸の名前はローカル作用の宣言なので、誤りなのは壊れたドット区切りである。
    for (const name of ['a..b', 'a.']) {
      await expect(
        run(`
$handler:
  ${JSON.stringify(name)}:
    $fn: m
    $body: x
$in: 1
`),
      ).rejects.toThrow(/\$handler clause name must be a path, a bare local name, or 'return'/);
    }
    // `$` で始まるキーを含むマッピングは節のマッピングではなく「関数に評価される式」として読まれる。
    await expect(
      run(`
$handler:
  "$fail":
    $fn: m
    $body: x
$in: 1
`),
    ).rejects.toThrow('unreserved $ key: $fail');
  });

  it('節の名前も環境の解決なので、束縛の無い名前は undefined reference になる', async () => {
    // 0.12 は「節に挙げた演算は登録が要らない」だったが、0.13 の節の名前は $handler の位置の
    // 環境で解決する。ホストが与えていない名前の節は書けない。
    await expect(
      run(`
$handler:
  vault.read:
    $fn: key
    $body: handled-\${key}
$in: {$vault.read: db/password}
`),
    ).rejects.toThrow(/undefined reference: vault/);
  });

  it('std の演算はホストの演算と同じ演算パイプラインを通る（節で差し替えられる）', async () => {
    await expect(
      run(`
$handler:
  std.get:
    $fn: name
    $body:
      $resume: shadowed-\${name}
  std.set:
    $fn: cells
    $body: {$resume: null}
$in:
  $do:
  - $std.set: {n: 1}
  - {$std.get: n}
`),
    ).resolves.toBe('shadowed-n');
  });

  it('std は普通の束縛なので $let で隠せ、$for の展開もそれに従う', async () => {
    // 名前空間は環境である。$for の展開が置く $std.each は展開先の環境で解決するので、
    // std を隠せば選択の束縛もその値を呼ぶ。
    await expect(
      run(`
$do:
- $let:
    std:
      each:
        $fn: xs
        $body: \${xs[0]}
- $for:
    x: [1, 2, 3]
- \${x}
`),
    ).resolves.toBe(1);
    // 隠した std の下では標準の演算も見えない。
    await expect(run('{$let: {std: 1}, $in: {$std.log: x}}')).rejects.toThrow(
      /cannot access key '\.log' of a non-mapping value/,
    );
  });

  it('演算の値は ${std.each} で参照して束縛でき、$.名前 で呼べる', async () => {
    // 別名を経た呼び出しも同じ演算の作用を起こす。
    await expect(
      run(`
$do:
- $handler: \${std.list}
- $let:
    pick: \${std.each}
- {$.pick: [1, 2]}
`),
    ).resolves.toEqual([1, 2]);
  });

  it('未定義の参照は評価前に拒まれる（呼び出しの先頭区画と ${...} の参照名）', async () => {
    await expect(run('{$.nope: 1}')).rejects.toThrow('undefined reference: nope');
    await expect(run('{$nope.f: 1}')).rejects.toThrow('undefined reference: nope');
    await expect(run('"${nope}"')).rejects.toThrow('undefined reference: nope');
    // 出現主義なので、実行されない分岐や $default の中の未定義参照も評価前に拒まれる。
    await expect(run('{$if: true, $then: ok, $else: "${nope}"}')).rejects.toThrow(
      'undefined reference: nope',
    );
    await expect(run('{$std.log: x, $default: "${nope}"}')).rejects.toThrow(
      'undefined reference: nope',
    );
  });
});

describe('ホストの値の失敗通知（演算）', () => {
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

  it('$default が捕捉して null になる', async () => {
    await expect(
      run('{$site.sel: h1, $default: null}', {
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
$handler: \${std.list}
$in:
  $do:
  - $let:
      v: {$std.each: [a, b, c]}
  - $site.sel: \${v}
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

  it('$handler の std.fail 節が $resume で呼び出し位置に代替値を返し、続く計算に反映される', async () => {
    await expect(
      run(
        `
$handler:
  std.fail:
    $fn: msg
    $body: {$resume: fallback}
$in:
  $do:
  - $let:
      v:
        $site.sel: h1
  - prefix-\${v}
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
    await expect(run('{$site.sel: h1, $default: none}', { ops })).resolves.toBe('none');
    await expect(run('{$site.sel: h1}', { ops })).rejects.toThrow('failure: no match: h1');
  });

  it('名前が OperationFailure でも value を持たない Error は通知ではなく捕捉できないエラー', async () => {
    await expect(
      run('{$site.sel: h1, $default: null}', {
        ops: {
          'site.sel': () => {
            throw Object.assign(new Error('boom'), { name: 'OperationFailure' });
          },
        },
      }),
    ).rejects.toThrow(/boom/);
  });

  it('OperationFailure でない例外は $default でも捕捉されず reject される', async () => {
    await expect(
      run('{$site.sel: h1, $default: null}', {
        ops: {
          'site.sel': () => {
            throw new Error('boom');
          },
        },
      }),
    ).rejects.toThrow(/boom/);
  });

  it('std.first は失敗した分岐を飛ばして次の分岐の値になる', async () => {
    await expect(
      run(
        `
$handler: \${std.first}
$in:
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

describe('ホストの値の失敗通知（関数）', () => {
  const failing = {
    'svc.fn': () => {
      throw new OperationFailure('no match');
    },
  };

  it('ホストの関数は同期でも非同期でもよい', async () => {
    await expect(
      run('{$svc.fn: abc}', { functions: { 'svc.fn': (s) => `sync-${String(s)}` } }),
    ).resolves.toBe('sync-abc');
    await expect(
      run('{$svc.fn: abc}', { functions: { 'svc.fn': async (s) => `async-${String(s)}` } }),
    ).resolves.toBe('async-abc');
  });

  it('関数の失敗通知も呼び出し位置の std.fail になり、$default と std.fail の節で捕捉できる', async () => {
    await expect(run('{$svc.fn: x}', { functions: failing })).rejects.toThrow('failure: no match');
    await expect(run('{$svc.fn: x, $default: fallback}', { functions: failing })).resolves.toBe(
      'fallback',
    );
    await expect(
      run(
        `
$handler:
  std.fail:
    $fn: m
    $body: 'caught \${m}'
$in: {$svc.fn: x}
`,
        { functions: failing },
      ),
    ).resolves.toBe('caught no match');
  });

  it('OperationFailure でない例外は関数でも捕捉できない', async () => {
    await expect(
      run('{$svc.fn: x, $default: null}', {
        functions: {
          'svc.fn': () => {
            throw new Error('boom');
          },
        },
      }),
    ).rejects.toThrow(/boom/);
  });

  it('関数は作用ではないので節に書けず、横取りもできない（演算との対比）', async () => {
    let opCalls = 0;
    let fnCalls = 0;
    const host = {
      ops: {
        'svc.op': () => {
          opCalls += 1;
          return 'from-op';
        },
      },
      functions: {
        'svc.fn': () => {
          fnCalls += 1;
          return 'from-fn';
        },
      },
    };
    // 演算は作用シグネチャに現れるので、節が横取りでき、そのとき実装は走らない。
    await expect(
      run(
        `
$handler:
  svc.op: {$fn: _, $body: intercepted}
$in: {$svc.op: x}
`,
        host,
      ),
    ).resolves.toBe('intercepted');
    expect(opCalls).toBe(0);
    // 関数は演算ではないので、節の名前にすること自体がエラーである。
    await expect(
      run(
        `
$handler:
  svc.fn: {$fn: _, $body: intercepted}
$in: {$svc.fn: x}
`,
        host,
      ),
    ).rejects.toThrow("$handler clause 'svc.fn' must name an operation, got: <function>");
    // 横取りする手立てが無いので、呼べば必ず実装が走る。
    await expect(run('{$svc.fn: x}', host)).resolves.toBe('from-fn');
    expect(fnCalls).toBe(1);
  });

  it('閉包はホストの関数にも演算にも渡せない（評価前の流れの検査）', async () => {
    await expect(
      run('{$svc.fn: {$fn: x, $body: "${x}"}}', { functions: { 'svc.fn': () => null } }),
    ).rejects.toThrow('a function value cannot be passed to a host function: $svc.fn');
    await expect(
      run('{$svc.op: {$fn: x, $body: "${x}"}}', { ops: { 'svc.op': () => null } }),
    ).rejects.toThrow('a function value cannot be passed to a host operation: $svc.op');
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
$handler: \${std.list}
$in:
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
$handler: \${std.list}
$in:
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
    await expect(run('{$for: {a.b: [1]}, $in: null}')).rejects.toThrow(/must not contain a dot/);
  });
});

describe('$do の文に置いた文脈の導入（$handler と {$std.state: 初期値}）', () => {
  it('先に置いた $handler ほど外側のハンドラになる（近い方が勝つ）', async () => {
    await expect(
      run(`
$do:
- $handler:
    std.fail: {$fn: _, $body: outer}
- $handler:
    std.fail: {$fn: _, $body: inner}
- {$std.fail: boom}
`),
    ).resolves.toBe('inner');
  });

  it('節の本体が起こす作用は自分では捕まらず、外側の $in を省いた $handler が処理する', async () => {
    await expect(
      run(`
$do:
- $handler:
    std.fail: {$fn: _, $body: outer}
- $handler:
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
- $handler:
    std.fail:
      $fn: _
      $body: \${d}
- {$std.fail: boom}
`),
    ).resolves.toBe('fallback');
  });

  it('$resume する節を $in を省いた $handler で仕掛けると、後続の文の演算を横取りできる', async () => {
    const logs: Value[] = [];
    await expect(
      run(
        `
$do:
- $handler:
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

  it('末尾に置いた文脈の導入の本体は null（$handler は return 節を通る）', async () => {
    await expect(run('{$do: [{$handler: {std.fail: {$fn: _, $body: x}}}]}')).resolves.toBe(null);
    await expect(run('{$do: [{$handler: {$std.state: {n: 0}}}]}')).resolves.toBe(null);
    await expect(
      run(`
$do:
- $handler:
    return: {$fn: v, $body: wrapped}
`),
    ).resolves.toBe('wrapped');
  });

  it('$in を省いた $handler は残りの文に記憶を通し、$in を書いた形は残りの文に及ばない', async () => {
    await expect(
      run(`
$do:
- $handler: {$std.state: {n: 5}}
- {$std.get: n}
`),
    ).resolves.toBe(5);
    await expect(
      run(`
$do:
- $handler: {$std.state: {n: 5}}
  $in: {$std.get: n}
- done
`),
    ).resolves.toBe('done');
    await expect(
      run(`
$do:
- $handler: {$std.state: {n: 5}}
  $in: {$std.get: n}
- {$std.get: n}
`),
    ).rejects.toThrow(/uninitialized cell: n/);
  });

  it('文の位置の外ではエラー', async () => {
    await expect(
      run('{$do: [{$let: {x: {$handler: {std.fail: {$fn: _, $body: 0}}}}}, 1]}'),
    ).rejects.toThrow(/\$handler without \$in is only allowed as a statement of \$do/);
    await expect(
      run('{$do: [{$let: {x: {$handler: {$std.state: {n: 0}}}}}, 1]}'),
    ).rejects.toThrow(/\$handler without \$in is only allowed as a statement of \$do/);
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

  it('std.mapping の計算したキーが __proto__ でもエントリになる', async () => {
    const r = await run(`
$handler: \${std.mapping}
$let:
  k:
    $std.each: [__proto__]
$in:
  key: \${k}
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

  it('$std.collect の into: mapping でも __proto__ はエントリになり、重複も検出される', async () => {
    const r = await run(`
$std.collect:
  in: [__proto__]
  with:
    $fn: k
    $body:
    - key: \${k}
      value: {x: 1}
  into: mapping
`);
    expect(ownProto(r)).toBe(true);
    await expect(
      run(`
$std.collect:
  in: [__proto__, __proto__]
  with:
    $fn: k
    $body:
    - key: \${k}
      value: {x: 1}
  into: mapping
`),
    ).rejects.toThrow(/duplicate key in \$std\.collect: __proto__/);
  });

  it('グローバルの Object.prototype は汚染されない', async () => {
    await run('"__proto__": {polluted: yes}');
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe('攻撃経路の防御（構造化入力を受け取るホスト向け）', () => {
  const own = (v: Value, k: string): boolean =>
    Object.prototype.hasOwnProperty.call(v as object, k);

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
$std.collect:
  in: [hasOwnProperty, hasOwnProperty]
  with:
    $fn: k
    $body:
    - key: \${k}
      value: 1
  into: mapping
`),
    ).rejects.toThrow(/duplicate key in \$std\.collect: hasOwnProperty/);
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

  // --- 値：関数値族（メソッド名の位置に閉包を置いても値に残せない） ---
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

  it('演算の値も文書の値へ脱出できない', async () => {
    const msg = /an operation value cannot escape into the document value/;
    await expect(run('op: "${std.each}"')).rejects.toThrow(msg);
    // 一段深く隠しても再帰で捕まえる
    await expect(run('a:\n- nested: {op: "${std.log}"}')).rejects.toThrow(msg);
    // 文字列への補間もできない
    await expect(run('op: "x${std.each}"')).rejects.toThrow(
      /cannot interpolate a list, mapping, null, function, or operation value into a string/,
    );
  });

  it('== と != は関数も演算も比較できない', async () => {
    await expect(
      run(`
$let:
  f: {$fn: x, $body: 1}
$in: \${f == f}
`),
    ).rejects.toThrow("'==' cannot compare a function or operation value, got: <function>");
    await expect(run('{$let: {e: "${std.each}"}, $in: "${e != e}"}')).rejects.toThrow(
      "'!=' cannot compare a function or operation value, got: <operation std.each>",
    );
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

  it('文書の形の誤りに位置が付く（キー走査・型の不一致）', async () => {
    await expect(run('server:\n  x:\n    $let: {a: 1}\n    $in: {$.a.self: 2}')).rejects.toThrow(
      "cannot access key '.self' of a non-mapping value (at server.x)",
    );
    await expect(run('a:\n  b: {$std.merge: {x: 1}}')).rejects.toThrow(
      '$std.merge requires a list of mappings, got: {"x":1} (at a.b)',
    );
  });

  it('評価前に拒まれる誤り（未定義の参照）には失敗位置が付かない', async () => {
    // 失敗位置は出力の値の中の場所なので、評価を始める前の拒否には位置がない。
    await expect(run('server:\n  conf: {$.a.self: 1}')).rejects.toThrow(
      expect.objectContaining({ message: 'undefined reference: a', path: undefined }),
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
    await expect(run('a:\n  b: {$std.fail: boom, $default: ok}')).resolves.toEqual({
      a: { b: 'ok' },
    });
    await expect(
      run(`
a:
  b:
    $handler: {std.fail: {$fn: m, $body: "caught \${m}"}}
    $in: {$std.fail: boom}
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
    const e = await run('a:\n  b:\n  - $handler: "${std.list}"\n    $in: [{$std.range: x}]').then(
      () => new Error('rejected されなかった'),
      (x: Error) => x,
    );
    expect(e.message.match(/\(at /g)).toHaveLength(1);
    expect(e.message).toContain('(at a.b[0])');
  });

  // 位置は出力の値の中の場所なので、最後の文そのものが失敗すればその値は
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

  it('$if の $then と $else で位置が伸びる', async () => {
    await expect(run('$if: true\n$then:\n  a: {$std.range: x}\n$else: null')).rejects.toThrow(
      '(at a)',
    );
    await expect(run('$if: false\n$then: null\n$else:\n  b: {$std.range: x}')).rejects.toThrow(
      '(at b)',
    );
  });

  it('$default を添えた本体で位置が伸びる（捕捉できないエラーはそのまま出る）', async () => {
    await expect(run('$do:\n- a: {$std.range: x}\n$default: fallback')).rejects.toThrow('(at a)');
  });

  it('$default の式で位置が伸びる（失敗時の値がそのまま出力になる）', async () => {
    await expect(
      run('a:\n  $std.fail: boom\n  $default:\n    b: {$std.range: q}'),
    ).rejects.toThrow('(at a.b)');
    await expect(
      run('a:\n  $std.param: nope\n  $default:\n    b: {$std.range: q}'),
    ).rejects.toThrow('(at a.b)');
  });

  it('文脈の導入を伴うマッピングのデータのキーで位置が伸びる', async () => {
    await expect(run('$let: {x: 1}\nserver:\n  hosts: [a, {$std.range: q}]')).rejects.toThrow(
      '(at server.hosts[1])',
    );
  });
});

describe('位置が凍る経路', () => {
  it('関数の式で与えた $handler の本体は凍る（値が呼び出しを経て返るため）', async () => {
    await expect(
      run(`
k:
  $handler: \${std.list}
  $in:
    a: {$std.range: x}
`),
    ).rejects.toThrow(expect.objectContaining({ path: 'k' }));
    // {$std.state: 初期値} も関数の式なので同じに凍る。
    await expect(
      run(`
k:
  $handler: {$std.state: {n: 0}}
  $in:
    a: {$std.range: x}
`),
    ).rejects.toThrow(expect.objectContaining({ path: 'k' }));
  });

  it('$let の束縛の右辺は凍る', async () => {
    await expect(run('k:\n  $let:\n    x:\n      a: {$std.range: q}\n  $in: 1')).rejects.toThrow(
      expect.objectContaining({ path: 'k' }),
    );
  });

  it('return の節を持つ $handler の本体は凍る', async () => {
    await expect(
      run(`
k:
  $handler:
    return: {$fn: v, $body: "\${v}"}
  $in:
    a: {$std.range: x}
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
  $handler: \${std.list}
  $in:
    $let: {x: 1}
    $in:
      a: {$std.range: q}
`),
    ).rejects.toThrow(expect.objectContaining({ path: 'k' }));
  });
});


describe('関数の式を置いた $handler の名乗りと形の検査', () => {
  it('std.first の全滅は利用者が書いた $handler: ${std.first} を名乗る', async () => {
    await expect(
      run(`
$handler: \${std.first}
$for: {x: [1, 2]}
$in: {$std.where: false}
`),
    ).rejects.toThrow('failure: every branch of $handler: ${std.first} failed or was cut');
  });

  it('$handler の式が演算に評価されたら作用を起こさず形の誤りとして拒む', async () => {
    await expect(run('{$handler: "${std.each}", $in: 1}')).rejects.toThrow(
      '$handler requires a mapping of clauses or a function, got: <operation std.each>',
    );
  });

  it('$handler の式がデータに評価されたら形の誤りとして拒む', async () => {
    await expect(run('{$let: {h: 5}, $handler: "${h}", $in: 1}')).rejects.toThrow(
      '$handler requires a mapping of clauses or a function, got: 5',
    );
  });

  it('本体の閉包を受け取る std の関数に関数でない値を直接渡すと、引数の形の誤りとして名乗る', async () => {
    await expect(run('{$std.list: 5}')).rejects.toThrow(
      '$std.list requires a function taking the body, got: 5',
    );
  });

  it('$default の式は展開により std.fail の節の本体なので、$resume は失敗した位置から再開する', async () => {
    await expect(
      run(`
$do:
- $let:
    x: {$std.fail: boom}
- got \${x}
$default: {$resume: recovered}
`),
    ).resolves.toBe('got recovered');
  });

  it('外側の節の本体に書いた $handler の return 節からは、外側の節の $resume が見える', async () => {
    await expect(
      run(`
$handler:
  ask:
    $fn: _
    $body:
      $handler:
        return:
          $fn: v
          $body: {$resume: "\${v}"}
      $in: 41
$in:
  $let:
    n: {$.ask: null}
  $in: \${n + 1}
`),
    ).resolves.toBe(42);
  });
});
