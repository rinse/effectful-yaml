/**
 * 文脈の導入を伴うマッピング（頭キー `$let`・`$std.state`・`$with`・`$std.for` を持ち、その頭を除いた
 * 残りが本体になる導出形）の動作確認。
 * 仕様: docs/grammar.md（草案 0.12）「文脈の導入を伴うマッピング」。
 */
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { evaluate, type EvaluateOptions } from '../src/eval.js';
import type { Value } from '../src/types.js';

const run = (src: string, options?: EvaluateOptions): Promise<Value> =>
  evaluate(parse(src), options);

// -----------------------------------------------------------------------------
// 受け入れ（grammar.md 用例）
// -----------------------------------------------------------------------------

describe('文脈の導入の受け入れ', () => {
  it('$in を省いた $let：パラメータの既定値と分岐', async () => {
    const yaml = `
$let:
  registry: ghcr.io/acme
  env: {$std.param: env, $default: dev}
name: api
image: \${registry}/api:\${env}
replicas:
  $if: \${env == 'prod'}
  $then: 3
  $else: 1
`;
    await expect(run(yaml)).resolves.toEqual({
      name: 'api',
      image: 'ghcr.io/acme/api:dev',
      replicas: 1,
    });
    await expect(run(yaml, { params: { env: 'prod' } })).resolves.toEqual({
      name: 'api',
      image: 'ghcr.io/acme/api:prod',
      replicas: 3,
    });
  });

  it('$in を省いた $with：局所ハンドラで未渡しパラメータを null にする', async () => {
    await expect(
      run(
        `
database:
  $with:
    std.fail: {$fn: _, $body: {$resume: null}}
  host: {$std.param: db_host}
  port: {$std.param: db_port}
`,
        { params: { db_host: 'db' } },
      ),
    ).resolves.toEqual({ database: { host: 'db', port: null } });
  });

  it('合成位置で文脈を導入する $let：$std.each の選択が包囲する $std.list に届く', async () => {
    await expect(
      run(`
$std.list:
  $let:
    x: {$std.each: [1, 2]}
  v: \${x}
`),
    ).resolves.toEqual([{ v: 1 }, { v: 2 }]);
  });

  it('$in を省いた $std.state：状態のスコープがマッピングの中で閉じる', async () => {
    await expect(
      run(`
$do:
- $std.set: {n: 100}
- inner:
    $std.state: {n: 0}
    a: {$do: [{$std.set: {n: 1}}, {$std.get: n}]}
    b: {$std.get: n}
  outer: {$std.get: n}
`),
    ).resolves.toEqual({ inner: { a: 1, b: 1 }, outer: 100 });
  });

  it('三つの頭を揃えて置く形', async () => {
    await expect(
      run(`
$let:
  base: 41
$std.state: {n: "\${base}"}
$with:
  std.fail: {$fn: _, $body: {$resume: "\${base}"}}
seed: {$std.get: n}
missing: {$std.param: nope}
`),
    ).resolves.toEqual({ seed: 41, missing: 41 });
  });

  it('残りが $if の文脈の導入：fizzbuzz が平らなリストになる', async () => {
    await expect(
      run(`
$std.list:
  $let:
    i0: {$std.each: {$std.range: 15}}
    i: \${i0 + 1}
  $if: \${i % 15 == 0}
  $then: fizzbuzz
  $else:
    $if: \${i % 3 == 0}
    $then: fizz
    $else:
      $if: \${i % 5 == 0}
      $then: buzz
      $else: "\${i}"
`),
    ).resolves.toEqual([
      1, 2, 'fizz', 4, 'buzz', 'fizz', 7, 8, 'fizz', 'buzz', 11, 'fizz', 13, 14, 'fizzbuzz',
    ]);
  });

  it('$with の頭と $in の本体', async () => {
    await expect(
      run(`
$with:
  std.fail: {$fn: _, $body: 0}
$in:
  $std.lookup: {in: {}, key: missing}
`),
    ).resolves.toBe(0);
  });

  it('頭が二つと $in：$std.state の初期値は先に書いた $let の束縛を見る', async () => {
    await expect(
      run(`
$let:
  start: 40
$std.state: {n: "\${start}"}
$in:
  $do:
  - $let:
      n: {$std.get: n}
  - $std.set: {n: "\${n + 2}"}
  - $std.get: n
`),
    ).resolves.toBe(42);
  });

  it('残りが演算の文脈の導入', async () => {
    await expect(
      run(`
$let:
  obj: {x: 10, y: 100}
$std.lookup:
  key: x
  in: \${obj}
`),
    ).resolves.toBe(10);
  });

  it('$in は最後の頭に付くので、どこに書いても同じ値になる', async () => {
    const both = [
      `
$let:
  base: 40
$std.state: {n: "\${base + 2}"}
$in: {$std.get: n}
`,
      `
$let:
  base: 40
$in: {$std.get: n}
$std.state: {n: "\${base + 2}"}
`,
    ];
    for (const yaml of both) await expect(run(yaml)).resolves.toBe(42);
  });

  it('$fn と同居する $let は関数全体を包む', async () => {
    // 束縛は関数の外で一度だけ評価されるので、二度呼んでもログは一つである。
    const logs: Value[] = [];
    await expect(
      run(
        `
$let:
  f:
    $fn: a
    $let: {y: {$std.log: made}}
    $body: \${a}
$in:
- {$.f: 1}
- {$.f: 2}
`,
        { onLog: (v) => logs.push(v) },
      ),
    ).resolves.toEqual([1, 2]);
    expect(logs).toEqual(['made']);
    // 束縛の右辺は関数の外なので、パラメータを参照できない。
    await expect(
      run(`
$let:
  f:
    $fn: a
    $let: {y: "\${a}"}
    $body: \${y}
$in: {$.f: 1}
`),
    ).rejects.toThrow('undefined reference: a');
  });

  it('$let と $with の頭が並ぶとき、先に書いた $let が外側になり $in は $with の本体である', async () => {
    await expect(
      run(`
$let:
  x: 1
$in: {$.throw: boom}
$with:
  throw: {$fn: m, $body: "caught \${m} \${x}"}
`),
    ).resolves.toBe('caught boom 1');
  });

  it('マッピングのキーに置いた $std.for：後の束縛が先の束縛を見て表を組み替える', async () => {
    const result = await run(`
$let:
  forms:
    "a{id}": [x, y]
    "b{id}": [z]
$std.mapping:
  $std.for:
    entry: \${forms}
    label: \${entry.value}
  key: \${label}
  value:
    id: \${entry.key}
`);
    expect(result).toEqual({ x: { id: 'a{id}' }, y: { id: 'a{id}' }, z: { id: 'b{id}' } });
    expect(Object.keys(result as object)).toEqual(['x', 'y', 'z']);
  });

  it('$in を伴う $std.for：$std.list の下で複数の束縛が総当たりになる', async () => {
    await expect(
      run(`
$std.list:
  $std.for:
    x: [1, 2]
    y: [10, 20]
  $in: \${x}-\${y}
`),
    ).resolves.toEqual(['1-10', '1-20', '2-10', '2-20']);
  });

  it('$do の文に置いた $std.for と $std.where で組を絞り込む', async () => {
    await expect(
      run(`
$std.list:
  $do:
  - $std.for:
      x: [1, 2, 3]
      y: [1, 2, 3]
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

  it('$std.for を $let より先に書くと、$let の右辺が選ばれた要素を見る', async () => {
    await expect(
      run(`
$std.list:
  $std.for:
    x: [1, 2]
  $let:
    y: \${x + 1}
  v: \${y}
`),
    ).resolves.toEqual([{ v: 2 }, { v: 3 }]);
  });

  it('束縛名にドットは使えない', async () => {
    await expect(run('{$std.for: {"a.b": 1}, $in: null}')).rejects.toThrow(
      '$std.for binding name must not contain a dot: a.b',
    );
  });

  it('束縛がマッピングでなければエラー', async () => {
    await expect(run('{$std.for: [1], $in: null}')).rejects.toThrow(
      '$std.for requires a mapping of bindings',
    );
  });

  it('$in の無い $std.for を $do の外に置くとエラー', async () => {
    await expect(run('{$std.for: {x: [1]}}')).rejects.toThrow(
      '$std.for without $in is only allowed as a statement of $do',
    );
  });

  it('データ位置の $std.for は境界そのものなので、選択のハンドラが無ければ拒否される', async () => {
    await expect(
      run(`
$std.for:
  x: [1, 2]
v: "\${x}"
`),
    ).rejects.toThrow(/unhandled choice/);
  });
});

// -----------------------------------------------------------------------------
// 展開との等価性（文脈の導入 ≡ $in に本体を書いた形）
// -----------------------------------------------------------------------------

describe('文脈の導入の展開との等価性', () => {
  it('$in を省いた $let：パラメータの既定値と分岐', async () => {
    const omitted = `
$let:
  registry: ghcr.io/acme
  env: {$std.param: env, $default: dev}
name: api
image: \${registry}/api:\${env}
replicas:
  $if: \${env == 'prod'}
  $then: 3
  $else: 1
`;
    const expanded = `
$let:
  registry: ghcr.io/acme
  env: {$std.param: env, $default: dev}
$in:
  name: api
  image: \${registry}/api:\${env}
  replicas:
    $if: \${env == 'prod'}
    $then: 3
    $else: 1
`;
    const a = await run(omitted);
    expect(a).toEqual(await run(expanded));
    expect(a).toEqual({ name: 'api', image: 'ghcr.io/acme/api:dev', replicas: 1 });
  });

  it('$in を省いた $with：局所ハンドラで未渡しパラメータを null にする（ログの順序も比べる）', async () => {
    const omitted = `
database:
  $with:
    std.fail: {$fn: _, $body: {$resume: null}}
  host: {$std.param: db_host}
  port: {$std.param: db_port}
`;
    const expanded = `
database:
  $with:
    std.fail: {$fn: _, $body: {$resume: null}}
  $in:
    host: {$std.param: db_host}
    port: {$std.param: db_port}
`;
    const options: EvaluateOptions = { params: { db_host: 'db' } };
    const omittedLogs: Value[] = [];
    const expandedLogs: Value[] = [];
    const a = await run(omitted, { ...options, onLog: (v) => omittedLogs.push(v) });
    const b = await run(expanded, { ...options, onLog: (v) => expandedLogs.push(v) });
    expect(a).toEqual(b);
    expect(a).toEqual({ database: { host: 'db', port: null } });
    expect(omittedLogs).toEqual(expandedLogs);
  });

  it('合成位置で文脈を導入する $let：$std.each の選択が包囲する $std.list に届く', async () => {
    const omitted = `
$std.list:
  $let:
    x: {$std.each: [1, 2]}
  v: \${x}
`;
    const expanded = `
$std.list:
  $let:
    x: {$std.each: [1, 2]}
  $in:
    v: \${x}
`;
    const a = await run(omitted);
    expect(a).toEqual(await run(expanded));
    expect(a).toEqual([{ v: 1 }, { v: 2 }]);
  });

  it('$in を省いた $std.state：状態のスコープがマッピングの中で閉じる', async () => {
    const omitted = `
$do:
- $std.set: {n: 100}
- inner:
    $std.state: {n: 0}
    a: {$do: [{$std.set: {n: 1}}, {$std.get: n}]}
    b: {$std.get: n}
  outer: {$std.get: n}
`;
    const expanded = `
$do:
- $std.set: {n: 100}
- inner:
    $std.state: {n: 0}
    $in:
      a: {$do: [{$std.set: {n: 1}}, {$std.get: n}]}
      b: {$std.get: n}
  outer: {$std.get: n}
`;
    const a = await run(omitted);
    expect(a).toEqual(await run(expanded));
    expect(a).toEqual({ inner: { a: 1, b: 1 }, outer: 100 });
  });

  it('三つの頭を揃えて置く形', async () => {
    const omitted = `
$let:
  base: 41
$std.state: {n: "\${base}"}
$with:
  std.fail: {$fn: _, $body: {$resume: "\${base}"}}
seed: {$std.get: n}
missing: {$std.param: nope}
`;
    const expanded = `
$let:
  base: 41
$in:
  $std.state: {n: "\${base}"}
  $in:
    $with:
      std.fail: {$fn: _, $body: {$resume: "\${base}"}}
    $in:
      seed: {$std.get: n}
      missing: {$std.param: nope}
`;
    const a = await run(omitted);
    expect(a).toEqual(await run(expanded));
    expect(a).toEqual({ seed: 41, missing: 41 });
  });

  it('残りが $if の文脈の導入', async () => {
    const omitted = `
$std.list:
  $let:
    i0: {$std.each: {$std.range: 15}}
    i: \${i0 + 1}
  $if: \${i % 15 == 0}
  $then: fizzbuzz
  $else:
    $if: \${i % 3 == 0}
    $then: fizz
    $else:
      $if: \${i % 5 == 0}
      $then: buzz
      $else: "\${i}"
`;
    const expanded = `
$std.list:
  $let:
    i0: {$std.each: {$std.range: 15}}
    i: \${i0 + 1}
  $in:
    $if: \${i % 15 == 0}
    $then: fizzbuzz
    $else:
      $if: \${i % 3 == 0}
      $then: fizz
      $else:
        $if: \${i % 5 == 0}
        $then: buzz
        $else: "\${i}"
`;
    const a = await run(omitted);
    expect(a).toEqual(await run(expanded));
    expect(a).toEqual([
      1, 2, 'fizz', 4, 'buzz', 'fizz', 7, 8, 'fizz', 'buzz', 11, 'fizz', 13, 14, 'fizzbuzz',
    ]);
  });

  it('$with の頭と $in の本体', async () => {
    const omitted = `
$with:
  std.fail: {$fn: _, $body: 0}
$in:
  $std.lookup: {in: {}, key: missing}
`;
    const expanded = `
$in:
  $std.lookup: {in: {}, key: missing}
$with:
  std.fail: {$fn: _, $body: 0}
`;
    const a = await run(omitted);
    expect(a).toEqual(await run(expanded));
    expect(a).toBe(0);
  });

  it('頭が二つと $in', async () => {
    const omitted = `
$let:
  start: 40
$std.state: {n: "\${start}"}
$in: {$std.get: n}
`;
    const expanded = `
$let:
  start: 40
$in:
  $std.state: {n: "\${start}"}
  $in: {$std.get: n}
`;
    const a = await run(omitted);
    expect(a).toEqual(await run(expanded));
    expect(a).toBe(40);
  });

  it('残りが演算の文脈の導入', async () => {
    const omitted = `
$let:
  obj: {x: 10, y: 100}
$std.lookup:
  key: x
  in: \${obj}
`;
    const expanded = `
$let:
  obj: {x: 10, y: 100}
$in:
  $std.lookup:
    key: x
    in: \${obj}
`;
    const a = await run(omitted);
    expect(a).toEqual(await run(expanded));
    expect(a).toBe(10);
  });

  it('$std.for は束縛を std.each で包んだ $let と一致する', async () => {
    const forHead = `
$std.list:
  $std.for:
    x: [1, 2]
    y: [10, 20]
  $in: \${x}-\${y}
`;
    const expanded = `
$std.list:
  $let:
    x: {$std.each: [1, 2]}
    y: {$std.each: [10, 20]}
  $in: \${x}-\${y}
`;
    const a = await run(forHead);
    expect(a).toEqual(await run(expanded));
    expect(a).toEqual(['1-10', '1-20', '2-10', '2-20']);
  });

  it('$std.for は束縛を std.each で包んだ $let と一致する（ログの順序も比べる）', async () => {
    const forHead = `
$std.list:
  $do:
  - $std.for:
      x: [1, 2]
  - $std.log: \${x}
  - \${x}
`;
    const expanded = `
$std.list:
  $do:
  - $let:
      x: {$std.each: [1, 2]}
  - $std.log: \${x}
  - \${x}
`;
    const forLogs: Value[] = [];
    const expandedLogs: Value[] = [];
    const a = await run(forHead, { onLog: (v) => forLogs.push(v) });
    const b = await run(expanded, { onLog: (v) => expandedLogs.push(v) });
    expect(a).toEqual(b);
    expect(a).toEqual([1, 2]);
    expect(forLogs).toEqual(expandedLogs);
    expect(forLogs).toEqual([1, 2]);
  });
});

// -----------------------------------------------------------------------------
// 並びとスコープ
// -----------------------------------------------------------------------------

describe('文脈の導入の並びとスコープ', () => {
  it('$let の後に置いた $with はその束縛を見る', async () => {
    await expect(
      run(`
$let:
  fallback: none
$with:
  std.fail:
    $fn: _
    $body: {$resume: "\${fallback}"}
host: {$std.param: db_host}
`),
    ).resolves.toEqual({ host: 'none' });
  });

  it('$with を $let より先に書くと、$with の節はまだ束縛を見られない', async () => {
    await expect(
      run(`
$with:
  std.fail:
    $fn: _
    $body: {$resume: "\${fallback}"}
$let:
  fallback: none
host: {$std.param: db_host}
`),
    ).rejects.toThrow('undefined reference: fallback');
  });

  it('データのキーとの相対位置は意味を持たない', async () => {
    await expect(
      run(`
name: api
$let:
  x: 1
v: "\${x}"
`),
    ).resolves.toEqual({ name: 'api', v: 1 });
  });

  it('入れ子：外で導入した束縛は内側のマッピングの頭の右辺とデータから見える', async () => {
    await expect(
      run(`
$let:
  base: 10
inner:
  $let:
    y: "\${base + 1}"
  z: "\${y + base}"
`),
    ).resolves.toEqual({ inner: { z: 21 } });
  });
});

// -----------------------------------------------------------------------------
// データ位置の境界
// -----------------------------------------------------------------------------

describe('文脈の導入とデータ位置の境界', () => {
  it('文脈の導入が作る境界は、データのキーの間で共有される', async () => {
    await expect(
      run(`
$let:
  x: 1
a: {$do: [{$std.set: {n: 1}}, null]}
b: {$std.get: n}
`),
    ).resolves.toEqual({ a: null, b: 1 });
  });

  it('データ位置の文脈の導入は境界そのものなので、選択のハンドラが無ければ拒否される', async () => {
    await expect(
      run(`
$let:
  x: {$std.each: [1, 2]}
v: "\${x}"
`),
    ).rejects.toThrow(/unhandled choice/);
  });
});

// -----------------------------------------------------------------------------
// ローカル作用
// -----------------------------------------------------------------------------

describe('文脈の導入とローカル作用', () => {
  it('$in を省いた $with が宣言したローカル作用は、データのキーから呼べる', async () => {
    // 節は $resume を呼ばないので、その戻り値がハンドラ全体の結果になり、
    // 呼び出しを包んでいたマッピングの残りは評価されない（節の戻り値がハンドラの継続を置き換える）。
    await expect(
      run(`
$with:
  throw:
    $fn: m
    $body: caught \${m}
a: {$.throw: boom}
`),
    ).resolves.toBe('caught boom');
  });

  it('$in を省いた $with が束縛した素通しの関数を $let で外へ持ち出して呼ぶと脱出のエラーになり、宣言位置は文脈の導入を伴うマッピングの構文パスになる', async () => {
    await expect(
      run(`
$let:
  f:
    $with:
      throw:
        $fn: msg
        $body: caught \${msg}
    v: \${throw}
$in:
  $.f.v: hi
`),
    ).rejects.toThrow("local effect 'throw' escaped its handler (declared at $let.f)");
    await expect(
      run(`
$let:
  services:
    $with:
      throw:
        $fn: msg
        $body: caught \${msg}
    v: \${throw}
$in:
  $.services.v: hi
`),
    ).rejects.toThrow("local effect 'throw' escaped its handler (declared at $let.services)");
  });
});

// -----------------------------------------------------------------------------
// 自己適用の検査
// -----------------------------------------------------------------------------

describe('文脈の導入と自己適用の検査', () => {
  it('自己適用のエラー位置は、書いたとおりの構文パス $let.f になる', async () => {
    await expect(
      run(`
$let:
  f:
    $fn: g
    $body: {$.g: "\${g}"}
v: {$.f: "\${f}"}
`),
    ).rejects.toThrow(
      'self-application detected: the function defined at $let.f may be applied to itself',
    );
  });
});

// -----------------------------------------------------------------------------
// どの形でもない残り
// -----------------------------------------------------------------------------

describe('$ キーとデータのキーの混在', () => {
  it.each([
    ['$let の残りの {$in, データのキー}', '{$let: {x: 1}, $in: 1, k: v}'],
    ['完結した $if', '{$if: true, $then: 1, $else: 2, k: v}'],
    ['$do', '{$do: [1], k: v}'],
    ['演算', '{$std.log: hi, k: v}'],
    ['補助キーを伴う演算', '{$std.param: x, name: api}'],
  ])('%s は $ key mixed with plain keys で拒否される', async (_label, yaml) => {
    await expect(run(yaml)).rejects.toThrow('$ key mixed with plain keys');
  });
});

describe('残りが空の頭', () => {
  it('頭だけのマッピングは $do の文の位置でだけ書ける', async () => {
    await expect(run('{$let: {b: 1}}')).rejects.toThrow(
      '$let without $in is only allowed as a statement of $do',
    );
  });
});

// -----------------------------------------------------------------------------
// $do の文の位置
// -----------------------------------------------------------------------------

describe('文脈の導入を伴うマッピングは $do の完結した文', () => {
  it('残りを持つ頭の値は、最後の文でなければ捨てられる', async () => {
    await expect(
      run(`
$do:
- $let: {x: 1}
  k: "\${x}"
- 2
`),
    ).resolves.toBe(2);
  });

  it('$in を伴う $with は残りの文を包まない', async () => {
    await expect(
      run(`
$do:
- {$with: {std.fail: {$fn: _, $body: caught}}, $in: {$std.fail: x}}
- done
`),
    ).resolves.toBe('done');
    await expect(
      run(`
$do:
- {$with: {std.fail: {$fn: _, $body: caught}}, $in: 1}
- {$std.fail: boom}
`),
    ).rejects.toThrow('failure: boom');
  });
});

// -----------------------------------------------------------------------------
// 失敗位置
// -----------------------------------------------------------------------------

describe('文脈の導入の本体は素通し', () => {
  it('残りが $if なら、位置は選ばれた分岐で伸びる', async () => {
    await expect(
      run('$let: {x: 1}\n$if: true\n$then:\n  a: {$std.range: q}\n$else: null'),
    ).rejects.toThrow('(at a)');
    await expect(
      run('$let: {x: 1}\n$if: false\n$then: null\n$else:\n  b: {$std.range: q}'),
    ).rejects.toThrow('(at b)');
  });
});
