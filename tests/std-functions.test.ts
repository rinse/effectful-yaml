/**
 * 検証テスト：docs/reference/ の「関数による実装」節に書かれた関数が、組み込みの std の関数と
 * 導出形と同じ振る舞い（値、ログの順序、失敗）をすることを固定する。
 *
 * 関数の定義は各ページの節の最初の YAML ブロックから読み、ページに書かれたとおりの
 * 文書を評価する。テストはその `$let` の定義を取り出し、組み込みと同じ本体に掛けて比較する。
 * `$std.input` に添えた `$default` の展開と、関数の式を置いた `$handler` の展開は、
 * ページに関数がないのでここに直接書く。
 */
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { evaluate, type EvaluateOptions } from '../src/eval.js';
import type { Value } from '../src/types.js';

type Doc = Record<string, Value>;

/** ページの「関数による実装」節の文書と期待値、および `$let` の定義。page は `std.list.md` の形。 */
async function impl(page: string): Promise<{ doc: Doc; expected: Value; defs: Doc }> {
  const md = await readFile(new URL(`../docs/reference/${page}`, import.meta.url), 'utf8');
  const section = md
    .split(/^## /m)
    .find((s) => s.startsWith('関数による実装') || s.startsWith('展開と関数による実装'));
  if (section === undefined) throw new Error(`${page} has no 関数による実装 section`);
  const blocks = [...section.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => parse(m[1]!) as Value);
  const doc = blocks[0] as Doc;
  return { doc, expected: blocks[1]!, defs: doc['$let'] as Doc };
}

const y = (src: string): Value => parse(src) as Value;
const thunk = (body: Value): Doc => ({ $fn: body });

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

/** 本体を `$handler: ${名前}` の下で評価する文書。 */
const under = (name: string, body: Value): Doc => ({ $handler: `\${${name}}`, $in: body });

describe('std.list の関数による実装', async () => {
  const { doc, expected, defs } = await impl('std.list.md');
  const fn = (body: Value): Doc => ({ $let: defs, $in: under('list', body) });
  const builtin = (body: Value): Doc => under('std.list', body);

  it('ページの文書がページの値になる', async () => {
    expect(await evaluate(doc)).toEqual(expected);
  });

  it('選択とログの順序、選択のない本体、打ち切りが一致する', async () => {
    const body = y(`
$do:
- $for:
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

  it('本体の閉包を直接渡す呼び出しも同じ値になる', async () => {
    const body = y(`{$do: [{$for: {x: [1, 2]}}, "\${x}"]}`);
    expect(
      await agree({ $let: defs, $in: { '$.list': thunk(body) } }, { '$std.list': thunk(body) }),
    ).toEqual([1, 2]);
  });

  it('分岐の失敗はどちらも全体の失敗になる', async () => {
    const body = y(`{$do: [{$for: {x: [1, 2]}}, {$std.fail: boom}]}`);
    await bothFail(fn(body), builtin(body));
  });
});

describe('std.mapping の関数による実装', async () => {
  const { doc, expected, defs } = await impl('std.mapping.md');
  const fn = (body: Value): Doc => ({ $let: defs, $in: under('mapping', body) });
  const builtin = (body: Value): Doc => under('std.mapping', body);

  it('ページの文書がページの値になる', async () => {
    expect(await evaluate(doc)).toEqual(expected);
  });

  it('$std.where による省略とキー順が一致する', async () => {
    const body = y(`
$do:
- $for:
    e: {b: 1, a: 2, c: 3}
- $std.where: \${e.value != 2}
- key: \${e.key}
  value: \${e.value * 10}
`);
    expect(await agree(fn(body), builtin(body))).toEqual({ b: 10, c: 30 });
  });

  it('キーの重複はどちらもエラーになる', async () => {
    const body = y(`{$do: [{$for: {x: [1, 2]}}, {key: k, value: 0}]}`);
    await bothFail(fn(body), builtin(body));
  });
});

describe('std.first の関数による実装', async () => {
  const { doc, expected, defs } = await impl('std.first.md');
  const fn = (body: Value): Doc => ({ $let: defs, $in: under('first', body) });
  const builtin = (body: Value): Doc => under('std.first', body);

  it('ページの文書がページの値になる（パラメータ未渡し）', async () => {
    expect(await evaluate(doc)).toEqual(expected);
  });

  it('最初の成功より後の分岐は評価されず、そのログも現れない', async () => {
    const body = y(`
$do:
- $for:
    v: [1, 2, 3]
- $if: \${v == 1}
  $then: {$std.fail: boom}
  $else: null
- $std.log: reached-\${v}
- \${v}
`);
    const logs: Value[] = [];
    expect(await agree(fn(body), builtin(body))).toBe(2);
    expect(await evaluate(builtin(body), { onLog: (v) => logs.push(v) })).toBe(2);
    expect(logs).toEqual(['reached-2']);
  });

  it('本体の std.get / std.set は印と衝突しない', async () => {
    const body = y(`
$do:
- $std.set: {n: 0}
- $for:
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
    const body = y(`{$do: [{$for: {v: [1, 2]}}, {$std.fail: nope}]}`);
    await bothFail(fn(body), builtin(body));
    const cut = y(`{$std.where: false}`);
    await bothFail(fn(cut), builtin(cut));
  });
});

describe('std.state の関数による実装', async () => {
  const { doc, expected, defs } = await impl('std.state.md');
  const fn = (init: Value, body: Value): Doc => ({
    $let: defs,
    $in: { $handler: { '$.state': init }, $in: body },
  });
  const builtin = (init: Value, body: Value): Doc => ({
    $handler: { '$std.state': init },
    $in: body,
  });

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

  it('未初期化のセルの読み出しはどちらも失敗し、$default で捕まる', async () => {
    const body = y(`{$std.get: none}`);
    await bothFail(fn({}, body), builtin({}, body));
    expect(
      await agree({ ...fn({}, body), $default: 'x' }, { ...builtin({}, body), $default: 'x' }),
    ).toBe('x');
  });

  it('貫流と分岐点で分かれる配置が一致する', async () => {
    const body = y(`
$do:
- $for:
    x: [a, b]
- $let:
    i: {$std.get: n}
- $std.set:
    n: \${i + 1}
- \${x}\${i}
`);
    const through = under('std.list', body);
    expect(await agree(fn({ n: 0 }, through), builtin({ n: 0 }, through))).toEqual(['a0', 'b1']);
    expect(
      await agree(under('std.list', fn({ n: 0 }, body)), under('std.list', builtin({ n: 0 }, body))),
    ).toEqual(['a0', 'b0']);
  });
});

describe('$default の関数による実装', async () => {
  const { doc, expected, defs } = await impl('default.md');
  const fn = (body: Value, dflt: Value): Doc => ({
    $let: defs,
    $in: { $handler: { '$.orElse': thunk(dflt) }, $in: body },
  });
  /** 本体が `$` 式ならそこに `$default` を添え、スカラーなら一文の `$do` に包む。 */
  const builtin = (body: Value, dflt: Value): Doc =>
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? { ...(body as Doc), $default: dflt }
      : { $do: [body], $default: dflt };

  it('ページの文書がページの値になる（パラメータ未渡し）', async () => {
    expect(await evaluate(doc)).toEqual(expected);
  });

  it('失敗は既定値に、成功は素通しになり、既定値の式は成功時に評価されない', async () => {
    const dflt = y(`{$do: [{$std.log: fell-back}, 0]}`);
    const missing = y(`{$std.lookup: {in: {}, key: k}}`);
    expect(await agree(fn(missing, dflt), builtin(missing, dflt))).toBe(0);
    expect(await agree(fn(7, dflt), builtin(7, dflt))).toBe(7);
    expect(await agree(fn(missing, null), builtin(missing, null))).toBeNull();
  });

  it('$default: {$std.where: false} の定型は包囲する選択の分岐を打ち切る', async () => {
    const row = (code: Value): Doc =>
      under('std.list', { $do: [{ $for: { r: [{ code: 'c1' }, {}, { code: 'c3' }] } }, code] });
    const cut = y(`{$std.where: false}`);
    const access = y('${r.code}');
    expect(await agree(row(fn(access, cut)), row(builtin(access, cut)))).toEqual(['c1', 'c3']);
  });

  it('$std.input に添えた $default は std.fail の節を持つ $handler への展開と一致する', async () => {
    const dflt = y(`{$do: [{$std.log: fell-back}, 5432]}`);
    const sugar = { '$std.input': 'port', $default: dflt };
    const expansion = {
      $handler: { 'std.fail': { $fn: dflt } },
      $in: { '$std.input': 'port' },
    };
    expect(await agree(sugar, expansion)).toBe(5432);
    expect(await agree(sugar, expansion, { input: { port: 80 } })).toBe(80);
  });
});

describe('std.where の関数による実装', async () => {
  const { doc, expected, defs } = await impl('std.where.md');

  it('ページの文書がページの値になる', async () => {
    expect(await evaluate(doc)).toEqual(expected);
  });

  it('真なら null、偽なら打ち切り、真偽値でなければエラーが一致する', async () => {
    const wrap = (guard: Value): Doc => ({
      $let: defs,
      $in: under('std.list', { $do: [{ $for: { x: [1, 2, 3] } }, guard, '${x}'] }),
    });
    expect(
      await agree(wrap(y('{$.where: "${x != 2}"}')), wrap(y('{$std.where: "${x != 2}"}'))),
    ).toEqual([1, 3]);
    expect(await agree({ $let: defs, $in: { '$.where': true } }, { '$std.where': true })).toBeNull();
    await bothFail(wrap(y('{$.where: 1}')), wrap(y('{$std.where: 1}')));
  });
});

describe('$for の関数による実装', async () => {
  const { doc, expected, defs } = await impl('for.md');

  it('ページの文書がページの値になる', async () => {
    expect(await evaluate(doc)).toEqual(expected);
  });

  it('二つの束縛は束縛ごとに作った bind の入れ子と一致し、マッピングはエントリを選ぶ', async () => {
    const fn = y(`
$handler: \${std.list}
$let:
  forms: {a: [1, 2], b: [3]}
  entries: {$.for: "\${forms}"}
$in:
  $.entries:
    $param: entry
    $fn:
      $let:
        labels: {$.for2: "\${entry.value}"}
      $in:
        $.labels:
          $param: label
          $fn: \${entry.key}\${label}
`);
    const builtin = y(`
$handler: \${std.list}
$let:
  forms: {a: [1, 2], b: [3]}
$for:
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
  const { doc, expected, defs } = await impl('std.lookup.md');
  const fn = (m: Value, k: Value): Doc => ({ $let: defs, $in: { '$.lookup': { in: m, key: k } } });
  const builtin = (m: Value, k: Value): Doc => ({ '$std.lookup': { in: m, key: k } });

  it('ページの文書がページの値になる', async () => {
    expect(await evaluate(doc)).toEqual(expected);
  });

  it('在るキーは同じ値、無いキーはどちらも失敗し、$default で同じ既定値になる', async () => {
    const m = { basic: 9, pro: 29 };
    expect(await agree(fn(m, 'pro'), builtin(m, 'pro'))).toBe(29);
    await bothFail(fn(m, 'none'), builtin(m, 'none'));
    expect(
      await agree({ ...fn(m, 'none'), $default: {} }, { ...builtin(m, 'none'), $default: {} }),
    ).toEqual({});
  });
});

describe('std.merge の関数による実装', async () => {
  const { doc, expected, defs } = await impl('std.merge.md');
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

describe('関数の式を置いた $handler の展開', () => {
  it('{$handler: 関数の式, $in: 本体} は {$let: {h: 関数の式}, $in: {$.h: 本体の閉包}} と一致する', async () => {
    const orElse = y(`
$param: [d, run]
$fn:
  $handler:
    std.fail: {$fn: "\${d}"}
    return: {$param: x, $fn: "\${x * 2}"}
  $in: {$.run: null}
`);
    const missing = y('{$std.lookup: {in: {}, key: missing}}');
    const sugar: Doc = {
      $let: { orElse },
      $in: {
        a: { $handler: { '$.orElse': 0 }, $in: missing },
        b: { $handler: { '$.orElse': 0 }, $in: 7 },
      },
    };
    const expansion: Doc = {
      $let: { orElse },
      $in: {
        a: { $let: { h: { '$.orElse': 0 } }, $in: { '$.h': thunk(missing) } },
        b: { $let: { h: { '$.orElse': 0 } }, $in: { '$.h': thunk(7) } },
      },
    };
    expect(await agree(sugar, expansion)).toEqual({ a: 0, b: 14 });
  });
});
