/**
 * 前置きを持つマッピング（頭キー `$let`・`$std.state`・`$with` を持ち、その頭を除いた
 * 残りが本体になる導出形）の動作確認。
 * 仕様: docs/grammar.md（草案 0.10）「前置きを持つマッピング」。
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

describe('前置きの受け入れ', () => {
  it('$let の前置き：パラメータの既定値と分岐（用例 A）', async () => {
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

  it('$with の前置き：局所ハンドラで未渡しパラメータを null にする（用例 B）', async () => {
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

  it('合成位置の $let の前置き：$std.each の選択が包囲する $std.list に届く（用例 C）', async () => {
    await expect(
      run(`
$std.list:
  $let:
    x: {$std.each: [1, 2]}
  v: \${x}
`),
    ).resolves.toEqual([{ v: 1 }, { v: 2 }]);
  });

  it('$std.state の前置き：状態のスコープがマッピングの中で閉じる（用例 D）', async () => {
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

  it('三つの前置きを揃えて置く形', async () => {
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

  it('残りが $if の前置き：fizzbuzz が平らなリストになる（用例 E）', async () => {
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

  it('$with の頭と $in の本体（用例 F）', async () => {
    await expect(
      run(`
$with:
  std.fail: {$fn: _, $body: 0}
$in:
  $std.lookup: {in: {}, key: missing}
`),
    ).resolves.toBe(0);
  });

  it('頭が二つと $in：$std.state の初期値は先に書いた $let の束縛を見る（用例 G）', async () => {
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

  it('残りが演算の前置き（用例 H）', async () => {
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

  it('$handle があるときの $with はその補助キーで、頭になるのは $let である', async () => {
    await expect(
      run(`
$let:
  x: 1
$handle: {$.throw: boom}
$with:
  throw: {$fn: m, $body: "caught \${m} \${x}"}
`),
    ).resolves.toBe('caught boom 1');
  });
});

// -----------------------------------------------------------------------------
// 展開との等価性（前置き ≡ 手で書いた $do）
// -----------------------------------------------------------------------------

describe('前置きの展開との等価性', () => {
  it('用例 A', async () => {
    const prelude = `
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
$do:
- $let:
    registry: ghcr.io/acme
    env: {$std.param: env, $default: dev}
- name: api
  image: \${registry}/api:\${env}
  replicas:
    $if: \${env == 'prod'}
    $then: 3
    $else: 1
`;
    const a = await run(prelude);
    expect(a).toEqual(await run(expanded));
    expect(a).toEqual({ name: 'api', image: 'ghcr.io/acme/api:dev', replicas: 1 });
  });

  it('用例 B（$with を含むのでログの順序も比べる）', async () => {
    const prelude = `
database:
  $with:
    std.fail: {$fn: _, $body: {$resume: null}}
  host: {$std.param: db_host}
  port: {$std.param: db_port}
`;
    const expanded = `
database:
  $do:
  - $with:
      std.fail: {$fn: _, $body: {$resume: null}}
  - host: {$std.param: db_host}
    port: {$std.param: db_port}
`;
    const options: EvaluateOptions = { params: { db_host: 'db' } };
    const preludeLogs: Value[] = [];
    const expandedLogs: Value[] = [];
    const a = await run(prelude, { ...options, onLog: (v) => preludeLogs.push(v) });
    const b = await run(expanded, { ...options, onLog: (v) => expandedLogs.push(v) });
    expect(a).toEqual(b);
    expect(a).toEqual({ database: { host: 'db', port: null } });
    expect(preludeLogs).toEqual(expandedLogs);
  });

  it('用例 C', async () => {
    const prelude = `
$std.list:
  $let:
    x: {$std.each: [1, 2]}
  v: \${x}
`;
    const expanded = `
$std.list:
  $do:
  - $let:
      x: {$std.each: [1, 2]}
  - v: \${x}
`;
    const a = await run(prelude);
    expect(a).toEqual(await run(expanded));
    expect(a).toEqual([{ v: 1 }, { v: 2 }]);
  });

  it('用例 D', async () => {
    const prelude = `
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
    $do:
    - $std.state: {n: 0}
    - a: {$do: [{$std.set: {n: 1}}, {$std.get: n}]}
      b: {$std.get: n}
  outer: {$std.get: n}
`;
    const a = await run(prelude);
    expect(a).toEqual(await run(expanded));
    expect(a).toEqual({ inner: { a: 1, b: 1 }, outer: 100 });
  });

  it('三つの前置きを揃えて置く形', async () => {
    const prelude = `
$let:
  base: 41
$std.state: {n: "\${base}"}
$with:
  std.fail: {$fn: _, $body: {$resume: "\${base}"}}
seed: {$std.get: n}
missing: {$std.param: nope}
`;
    const expanded = `
$do:
- $let:
    base: 41
- $std.state: {n: "\${base}"}
- $with:
    std.fail: {$fn: _, $body: {$resume: "\${base}"}}
- seed: {$std.get: n}
  missing: {$std.param: nope}
`;
    const a = await run(prelude);
    expect(a).toEqual(await run(expanded));
    expect(a).toEqual({ seed: 41, missing: 41 });
  });

  it('用例 E', async () => {
    const prelude = `
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
    const a = await run(prelude);
    expect(a).toEqual(await run(expanded));
    expect(a).toEqual([
      1, 2, 'fizz', 4, 'buzz', 'fizz', 7, 8, 'fizz', 'buzz', 11, 'fizz', 13, 14, 'fizzbuzz',
    ]);
  });

  it('用例 F', async () => {
    const prelude = `
$with:
  std.fail: {$fn: _, $body: 0}
$in:
  $std.lookup: {in: {}, key: missing}
`;
    const expanded = `
$handle:
  $std.lookup: {in: {}, key: missing}
$with:
  std.fail: {$fn: _, $body: 0}
`;
    const a = await run(prelude);
    expect(a).toEqual(await run(expanded));
    expect(a).toBe(0);
  });

  it('用例 G', async () => {
    const prelude = `
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
    const a = await run(prelude);
    expect(a).toEqual(await run(expanded));
    expect(a).toBe(40);
  });

  it('用例 H', async () => {
    const prelude = `
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
    const a = await run(prelude);
    expect(a).toEqual(await run(expanded));
    expect(a).toBe(10);
  });
});

// -----------------------------------------------------------------------------
// 並びとスコープ
// -----------------------------------------------------------------------------

describe('前置きの並びとスコープ', () => {
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

  it('入れ子：外の前置きの束縛は内側のマッピングの前置きの右辺とデータから見える', async () => {
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

describe('前置きとデータ位置の境界', () => {
  it('前置きが作る境界は、データのキーの間で共有される', async () => {
    await expect(
      run(`
$let:
  x: 1
a: {$do: [{$std.set: {n: 1}}, null]}
b: {$std.get: n}
`),
    ).resolves.toEqual({ a: null, b: 1 });
  });

  it('データ位置の前置きは境界そのものなので、選択のハンドラが無ければ拒否される', async () => {
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

describe('前置きとローカル作用', () => {
  it('$with の前置きが宣言したローカル作用は、データのキーから呼べる', async () => {
    // 節は $resume を呼ばないので、その戻り値が $handle 全体の結果になり、
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

  it('$with の前置きが束縛した素通しの関数を $let で外へ持ち出して呼ぶと脱出のエラーになり、宣言位置は前置きマッピングの構文パスになる', async () => {
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

describe('前置きと自己適用の検査', () => {
  it('自己適用のエラー位置は前置きマッピングの構文パスになる（$do[0].$let.f ではない）', async () => {
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

describe('残りが空の前置き', () => {
  it('頭だけのマッピングは $do の文の位置でだけ書ける', async () => {
    await expect(run('{$let: {b: 1}}')).rejects.toThrow(
      '$let without $in is only allowed as a statement of $do',
    );
  });
});

// -----------------------------------------------------------------------------
// $do の文の位置
// -----------------------------------------------------------------------------

describe('前置きを持つマッピングは $do の完結した文', () => {
  it('残りを持つ前置きの値は、最後の文でなければ捨てられる', async () => {
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

describe('前置きの本体は素通し', () => {
  it('残りが $if なら、位置は選ばれた分岐で伸びる', async () => {
    await expect(
      run('$let: {x: 1}\n$if: true\n$then:\n  a: {$std.range: q}\n$else: null'),
    ).rejects.toThrow('(at a)');
    await expect(
      run('$let: {x: 1}\n$if: false\n$then: null\n$else:\n  b: {$std.range: q}'),
    ).rejects.toThrow('(at b)');
  });
});
