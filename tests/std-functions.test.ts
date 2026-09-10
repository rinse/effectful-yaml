/**
 * 検証テスト：docs/reference/std.*.md の「関数による実装」節に書かれた関数が、
 * 組み込みの std の形と同じ振る舞い（値、ログの順序、失敗）をすることを固定する。
 *
 * 関数の定義は各ページの節の最初の YAML ブロックから読み、ページに書かれたとおりの
 * 文書を評価する。テストはその `$let` の定義を取り出し、組み込みと同じ本体に掛けて比較する。
 * std.param の `$default` と $std.handler の展開はページに関数がないので、ここに直接書く。
 */
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { evaluate, type EvaluateOptions } from '../src/eval.js';
import type { Value } from '../src/types.js';

type Doc = Record<string, Value>;

/** ページの「関数による実装」節の文書と期待値、および `$let` の定義。 */
async function impl(name: string): Promise<{ doc: Doc; expected: Value; defs: Doc }> {
  const md = await readFile(new URL(`../docs/reference/std.${name}.md`, import.meta.url), 'utf8');
  const section = md.split(/^## /m).find((s) => s.startsWith('関数による実装') || s.startsWith('展開と関数による実装'));
  if (section === undefined) throw new Error(`std.${name}.md has no 関数による実装 section`);
  const blocks = [...section.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => parse(m[1]!) as Value);
  const doc = blocks[0] as Doc;
  return { doc, expected: blocks[1]!, defs: doc['$let'] as Doc };
}

const y = (src: string): Value => parse(src) as Value;
const thunk = (body: Value): Doc => ({ $fn: '_', $body: body });

/** 関数版と組み込みを評価し、値とログの列が一致することを確かめて値を返す。 */
async function agree(fn: Value, builtin: Value, options: EvaluateOptions = {}): Promise<Value> {
  const fnLogs: Value[] = [];
  const builtinLogs: Value[] = [];
  const f = await evaluate(fn, { ...options, onLog: (v) => fnLogs.push(v) });
  const b = await evaluate(builtin, { ...options, onLog: (v) => builtinLogs.push(v) });
  expect(f).toEqual(b);
  expect(JSON.stringify(f)).toBe(JSON.stringify(b)); // キー順まで
  expect(fnLogs).toEqual(builtinLogs);
  return b;
}

async function bothFail(fn: Value, builtin: Value): Promise<void> {
  await expect(evaluate(fn)).rejects.toThrow();
  await expect(evaluate(builtin)).rejects.toThrow();
}

describe('std.list の関数による実装', async () => {
  const { doc, expected, defs } = await impl('list');
  const fn = (body: Value): Doc => ({ $let: defs, $in: { '$.list': thunk(body) } });
  const builtin = (body: Value): Doc => ({ '$std.list': body });

  it('ページの文書がページの値になる', async () => {
    expect(await evaluate(doc)).toEqual(expected);
  });

  it('選択とログの順序、選択のない本体、打ち切りが一致する', async () => {
    const body = y(`
$do:
- $std.for:
    x: [1, 2, 3]
- $std.log: \${x}
- $std.where: \${x != 2}
- \${x * 10}
`);
    expect(await agree(fn(body), builtin(body))).toEqual([10, 30]);
    expect(await agree(fn(7), builtin(7))).toEqual([7]);
    const cut = y(`{$std.where: false}`);
    expect(await agree(fn(cut), builtin(cut))).toEqual([]);
  });

  it('分岐の失敗はどちらも全体の失敗になる', async () => {
    const body = y(`{$do: [{$std.for: {x: [1, 2]}}, {$std.fail: boom}]}`);
    await bothFail(fn(body), builtin(body));
  });
});

describe('std.mapping の関数による実装', async () => {
  const { doc, expected, defs } = await impl('mapping');
  const fn = (body: Value): Doc => ({ $let: defs, $in: { '$.mapping': thunk(body) } });
  const builtin = (body: Value): Doc => ({ '$std.mapping': body });

  it('ページの文書がページの値になる', async () => {
    expect(await evaluate(doc)).toEqual(expected);
  });

  it('$std.where による省略とキー順が一致する', async () => {
    const body = y(`
$do:
- $std.for:
    e: {b: 1, a: 2, c: 3}
- $std.where: \${e.value != 2}
- key: \${e.key}
  value: \${e.value * 10}
`);
    expect(await agree(fn(body), builtin(body))).toEqual({ b: 10, c: 30 });
  });

  it('キーの重複はどちらもエラーになる', async () => {
    const body = y(`{$do: [{$std.for: {x: [1, 2]}}, {key: k, value: 0}]}`);
    await bothFail(fn(body), builtin(body));
  });
});

describe('std.first の関数による実装', async () => {
  const { doc, expected, defs } = await impl('first');
  const fn = (body: Value): Doc => ({ $let: defs, $in: { '$.first': thunk(body) } });
  const builtin = (body: Value): Doc => ({ '$std.first': body });

  it('ページの文書がページの値になる（パラメータ未渡し）', async () => {
    expect(await evaluate(doc)).toEqual(expected);
  });

  it('最初の成功より後の分岐は評価されず、そのログも現れない', async () => {
    const body = y(`
$do:
- $std.for:
    v: [1, 2, 3]
- $if: \${v == 1}
  $then: {$std.fail: boom}
  $else: null
- $std.log: reached-\${v}
- \${v}
`);
    const logs: Value[] = [];
    expect(await agree(fn(body), builtin(body), { onLog: (v) => logs.push(v) })).toBe(2);
    expect(await evaluate(builtin(body), { onLog: (v) => logs.push(v) })).toBe(2);
    expect(logs).toEqual(['reached-2']);
  });

  it('本体の std.get / std.set は印と衝突しない', async () => {
    const body = y(`
$do:
- $std.set: {n: 0}
- $std.for:
    v: [a, b]
- $let:
    n: {$std.get: n}
- $std.set:
    n: \${n + 1}
- $std.where: \${n == 1}
- \${v}\${n}
`);
    expect(await agree(fn(body), builtin(body))).toBe('b1');
  });

  it('全分岐が失敗または打ち切りならどちらも失敗する', async () => {
    const body = y(`{$do: [{$std.for: {v: [1, 2]}}, {$std.fail: nope}]}`);
    await bothFail(fn(body), builtin(body));
    const cut = y(`{$std.where: false}`);
    await bothFail(fn(cut), builtin(cut));
  });
});

describe('std.state の関数による実装', async () => {
  const { doc, expected, defs } = await impl('state');
  const fn = (init: Value, body: Value): Doc => ({
    $let: { ...defs, run: { '$.state': init } },
    $in: { '$.run': thunk(body) },
  });
  const builtin = (init: Value, body: Value): Doc => ({ '$std.state': init, $in: body });

  it('ページの文書がページの値になる', async () => {
    expect(await evaluate(doc)).toEqual(expected);
  });

  it('get / set の並び、複数セル、未作成のセルへの set が一致する', async () => {
    const body = y(`
$do:
- $let:
    a: {$std.get: n}
- $std.set: {n: 5, m: 7}
- $std.log: \${a}
- $let:
    b: {$std.get: n}
    c: {$std.get: m}
- \${a + b + c}
`);
    expect(await agree(fn({ n: 1 }, body), builtin({ n: 1 }, body))).toBe(13);
  });

  it('未初期化のセルの読み出しはどちらも失敗し、$std.opt で捕まる', async () => {
    const body = y(`{$std.get: none}`);
    await bothFail(fn({}, body), builtin({}, body));
    expect(await agree({ '$std.opt': fn({}, body), $default: 'x' }, { '$std.opt': builtin({}, body), $default: 'x' })).toBe('x');
  });

  it('貫流と分岐点で分かれる配置が一致する', async () => {
    const body = y(`
$do:
- $std.for:
    x: [a, b]
- $let:
    i: {$std.get: n}
- $std.set:
    n: \${i + 1}
- \${x}\${i}
`);
    const through = { '$std.list': body };
    expect(await agree(fn({ n: 0 }, through), builtin({ n: 0 }, through))).toEqual(['a0', 'b1']);
    expect(await agree({ '$std.list': fn({ n: 0 }, body) }, { '$std.list': builtin({ n: 0 }, body) })).toEqual(['a0', 'b0']);
  });
});

describe('std.opt の関数による実装', async () => {
  const { doc, expected, defs } = await impl('opt');
  const fn = (body: Value, dflt: Value = null): Doc => ({
    $let: { ...defs, or: { '$.opt': thunk(dflt) } },
    $in: { '$.or': thunk(body) },
  });
  const builtin = (body: Value, dflt: Value = null): Doc => ({ '$std.opt': body, $default: dflt });

  it('ページの文書がページの値になる', async () => {
    expect(await evaluate(doc)).toEqual(expected);
  });

  it('失敗は既定値に、成功は素通しになり、$default は成功時に評価されない', async () => {
    const dflt = y(`{$do: [{$std.log: fell-back}, 0]}`);
    const missing = y(`{$std.lookup: {in: {}, key: k}}`);
    expect(await agree(fn(missing, dflt), builtin(missing, dflt))).toBe(0);
    expect(await agree(fn(7, dflt), builtin(7, dflt))).toBe(7);
    expect(await agree(fn(missing), { '$std.opt': missing })).toBeNull();
  });

  it('$default: {$std.where: false} の定型は包囲する選択の分岐を打ち切る', async () => {
    const row = (code: Value): Doc => ({ '$std.list': { $do: [{ '$std.for': { r: [{ code: 'c1' }, {}, { code: 'c3' }] } }, code] } });
    const cut = y(`{$std.where: false}`);
    const access = y('${r.code}');
    expect(await agree(row(fn(access, cut)), row(builtin(access, cut)))).toEqual(['c1', 'c3']);
  });
});

describe('std.where の関数による実装', async () => {
  const { doc, expected, defs } = await impl('where');

  it('ページの文書がページの値になる', async () => {
    expect(await evaluate(doc)).toEqual(expected);
  });

  it('真なら null、偽なら打ち切り、真偽値でなければエラーが一致する', async () => {
    const wrap = (guard: Value): Doc => ({
      $let: defs,
      $in: { '$std.list': { $do: [{ '$std.for': { x: [1, 2, 3] } }, guard, '${x}'] } },
    });
    expect(await agree(wrap(y('{$.where: "${x != 2}"}')), wrap(y('{$std.where: "${x != 2}"}')))).toEqual([1, 3]);
    expect(await agree({ $let: defs, $in: { '$.where': true } }, { '$std.where': true })).toBeNull();
    await bothFail(wrap(y('{$.where: 1}')), wrap(y('{$std.where: 1}')));
  });
});

describe('std.for の関数による実装', async () => {
  const { doc, expected, defs } = await impl('for');

  it('ページの文書がページの値になる', async () => {
    expect(await evaluate(doc)).toEqual(expected);
  });

  it('二つの束縛は束縛ごとに作った bind の入れ子と一致し、マッピングはエントリを選ぶ', async () => {
    const fn = y(`
$std.list:
  $let:
    forms: {a: [1, 2], b: [3]}
    entries: {$.for: "\${forms}"}
  $in:
    $.entries:
      $fn: entry
      $body:
        $let:
          labels: {$.for2: "\${entry.value}"}
        $in:
          $.labels:
            $fn: label
            $body: \${entry.key}\${label}
`);
    const builtin = y(`
$std.list:
  $let:
    forms: {a: [1, 2], b: [3]}
  $std.for:
    entry: \${forms}
    label: \${entry.value}
  $in: \${entry.key}\${label}
`);
    // 同じ for を入れ子に適用すると自己適用として拒まれる（ページの規則）ので、束縛ごとに値を作る。
    const twoFors: Doc = { ...defs, for2: structuredClone(defs['for']!) };
    expect(await agree({ $let: twoFors, $in: fn }, builtin)).toEqual(['a1', 'a2', 'b3']);
  });
});

describe('std.lookup の関数による実装', async () => {
  const { doc, expected, defs } = await impl('lookup');
  const fn = (m: Value, k: Value): Doc => ({ $let: { ...defs, at: { '$.lookup': m } }, $in: { '$.at': k } });
  const builtin = (m: Value, k: Value): Doc => ({ '$std.lookup': { in: m, key: k } });

  it('ページの文書がページの値になる', async () => {
    expect(await evaluate(doc)).toEqual(expected);
  });

  it('在るキーは同じ値、無いキーはどちらも失敗し、$std.opt で同じ既定値になる', async () => {
    const m = { basic: 9, pro: 29 };
    expect(await agree(fn(m, 'pro'), builtin(m, 'pro'))).toBe(29);
    await bothFail(fn(m, 'none'), builtin(m, 'none'));
    expect(await agree({ '$std.opt': fn(m, 'none'), $default: {} }, { '$std.opt': builtin(m, 'none'), $default: {} })).toEqual({});
  });
});

describe('std.merge の関数による実装', async () => {
  const { doc, expected, defs } = await impl('merge');
  const fn = (ms: Value): Doc => ({ $let: defs, $in: { '$.merge': ms } });
  const builtin = (ms: Value): Doc => ({ '$std.merge': ms });

  it('ページの文書がページの値になる（キー順まで）', async () => {
    const v = await evaluate(doc);
    expect(v).toEqual(expected);
    expect(Object.keys(v as object)).toEqual(Object.keys(expected as object));
  });

  it('空リスト、三つ以上、null の上書き、浅いマージが一致する', async () => {
    expect(await agree(fn([]), builtin([]))).toEqual({});
    const ms: Value = [{ a: { x: 1 }, b: 1 }, { b: null, c: 2 }, { a: { y: 2 }, d: 3 }];
    expect(await agree(fn(ms), builtin(ms))).toEqual({ a: { y: 2 }, b: null, c: 2, d: 3 });
  });
});

describe('std.param の $default の展開', () => {
  it('{$std.param: 名前, $default: 式} は {$std.opt: {$std.param: 名前}, $default: 式} と一致する', async () => {
    const dflt = y(`{$do: [{$std.log: fell-back}, 5432]}`);
    const sugar = { '$std.param': 'port', $default: dflt };
    const opt = { '$std.opt': { '$std.param': 'port' }, $default: dflt };
    expect(await agree(sugar, opt)).toBe(5432);
    expect(await agree(sugar, opt, { params: { port: 80 } })).toBe(80);
  });
});

describe('$std.handler の展開', () => {
  it('{$std.handler: 節} は {$fn: t, $body: {$with: 節, $in: {$.t: null}}} と一致する', async () => {
    const clauses = y(`
std.fail: {$fn: _, $body: 0}
return: {$fn: x, $body: "\${x * 2}"}
`);
    const use = (handler: Value): Doc => ({
      $let: { h: handler },
      $in: {
        a: { '$.h': thunk(y('{$std.lookup: {in: {}, key: missing}}')) },
        b: { '$.h': thunk(7) },
      },
    });
    expect(
      await agree(use({ '$std.handler': clauses }), use({ $fn: 't', $body: { $with: clauses, $in: { '$.t': null } } })),
    ).toEqual({ a: 0, b: 14 });
  });
});
