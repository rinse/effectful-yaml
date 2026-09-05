/**
 * マッピングの前置き（データのキーを持つマッピングに書いた、本体を欠いた二項形
 * `$let`・`$std.state`・`$with` が `$do` へ展開される導出形）の動作確認。
 * 仕様: docs/grammar.md（草案 0.9）「$do」節の前置き。
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
// 前置きにならない混在（従来どおりのエラー）
// -----------------------------------------------------------------------------

describe('完結した $ 式とデータのキーの混在は前置きにならない', () => {
  it.each([
    ['$in を伴う $let', '{$let: {x: 1}, $in: 1, k: v}'],
    ['完結した $if', '{$if: true, $then: 1, $else: 2, k: v}'],
    ['$do', '{$do: [1], k: v}'],
    ['演算', '{$std.log: hi, k: v}'],
  ])('%s とデータのキーの混在は $ key mixed with plain keys で拒否される', async (_label, yaml) => {
    await expect(run(yaml)).rejects.toThrow('$ key mixed with plain keys');
  });
});
