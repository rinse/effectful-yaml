/**
 * 保持レンダラ renderPreserving の仕様テスト。
 *
 * 契約：
 * 1. renderPreserving(source, result) は YAML テキストを返し、
 *    それを parse すると result と deepEqual になる（常に成り立つ大前提）。
 * 2. 評価が値を変えなかった部分木は、コメント・整形・キー順・クォート込みで
 *    原文のバイト列がそのまま出力に現れる。置換されるのは評価で値が変わった
 *    最小の部分木（＝計算の島）だけである。
 * 3. 島の置換テキストは yaml の stringify（ブロック文脈）/ JSON 互換のフロー
 *    （フロー文脈）で書く。島の内側のコメントは失われる（仕様）。
 * 4. 残りがデータであるブロック形式の前置きを持つマッピングは島にならない。頭の `$` の対が
 *    行内コメントごと消え、データのキーの対はコメントを保ったまま内側へ降りる。
 *    残りが主形の前置き、フロー形式の前置き、シーケンスの標識と同じ行に書かれた前置きは
 *    島として置換する。
 * 5. 原文と結果の形が合わない場合（選択が島の外へ漏れて文書全体が分岐した、
 *    前置きの `$with` の節が本体を打ち切って値がマッピングでなくなった等）は
 *    エラーにせず、合わなくなったノード全体（最悪は文書全体）の置換に退化する。
 */
import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { evaluate, type EvaluateOptions } from '../src/eval.js';
import { renderPreserving } from '../src/preserve.js';

/** 評価して保持レンダリングし、大前提（契約 1）を毎回検証する。 */
async function render(src: string, options?: EvaluateOptions): Promise<string> {
  const value = await evaluate(parse(src), options);
  const out = renderPreserving(src, value);
  expect(parse(out)).toEqual(value);
  return out;
}

describe('恒等：$ を含まない文書', () => {
  it('コメント・整形・キー順・フロー形式込みでバイト単位に不変', async () => {
    const src = `# 先頭コメント
name: demo   # 行内コメント

items:
  - 1
  -   2     # 揃っていないインデント
flow: {a: 1, b: [x, y]}
"quoted": 'single'

# 末尾コメント
`;
    await expect(render(src)).resolves.toBe(src);
  });
});

describe('島の置換：周囲は不変', () => {
  it('ブロックの島は同じ位置にブロックで展開され、前後のコメントが残る', async () => {
    const src = `# head
a: 1 # keep
b:
  $std.range: 2
c: 3 # tail
`;
    await expect(render(src)).resolves.toBe(`# head
a: 1 # keep
b:
  - 0
  - 1
c: 3 # tail
`);
  });

  it('フローで書かれた島はフローで置換される', async () => {
    const src = `list: [1, {$std.range: 2}, 9]
`;
    await expect(render(src)).resolves.toBe(`list: [1, [0,1], 9]
`);
  });

  it('キー行と同じ行のフローの島も同じ行に収まる', async () => {
    const src = `a: 1
b: {$std.range: 2}
c: 3
`;
    await expect(render(src)).resolves.toBe(`a: 1
b: [0,1]
c: 3
`);
  });

  it('深い位置の島だけが置換され、兄弟のコメントは残る', async () => {
    const src = `outer:
  # この島だけ変わる
  inner:
    $std.range: 1
  keep: [1, 2] # 触らない
`;
    await expect(render(src)).resolves.toBe(`outer:
  # この島だけ変わる
  inner:
    - 0
  keep: [1, 2] # 触らない
`);
  });

  it('スカラーに評価される島は島の位置にスカラーが置かれる', async () => {
    const src = `# 挨拶
greeting:
  $std.param: user
`;
    await expect(render(src, { params: { user: 'rinse' } })).resolves.toBe(`# 挨拶
greeting:
  rinse
`);
  });
});

describe('$$ エスケープ：値とキー', () => {
  it('値の $$ は解決され、行内コメントは残る', async () => {
    const src = `services:
  web:
    env: $\${DB_URL} # compose 変数はそのまま残す
`;
    await expect(render(src)).resolves.toBe(`services:
  web:
    env: \${DB_URL} # compose 変数はそのまま残す
`);
  });

  it('キーの $$ はキーだけが直り、値と行内コメントは原文のまま', async () => {
    const src = `$$do: 1 # キーの $$ だけ直る
plain: 2
`;
    await expect(render(src)).resolves.toBe(`$do: 1 # キーの $$ だけ直る
plain: 2
`);
  });

  it('ブロックスカラー中の $$ も正しい値になる（バイト表現は問わない）', async () => {
    const src = 'msg: |\n  costs $$5\n';
    const out = await render(src);
    expect(parse(out)).toEqual({ msg: 'costs $5\n' });
  });
});

describe('前置きを持つマッピング', () => {
  it('前置きの対は行内コメントごと消え、データのキーのコメントは残る', async () => {
    const src = `# 先頭
$let:
  registry: ghcr.io/acme   # 前置きの中
name: api   # 名前
# データのキーの前
image: \${registry}/api
# 末尾
`;
    await expect(render(src)).resolves.toBe(`# 先頭
name: api   # 名前
# データのキーの前
image: ghcr.io/acme/api
# 末尾
`);
  });

  it('三つの前置きを並べても、残るのはデータのキーだけ', async () => {
    const src = `$let:
  base: 41
$std.state: {n: "\${base}"}
$with:
  std.fail: {$fn: _, $body: {$resume: "\${base}"}}
seed: {$std.get: n}   # 状態
missing: {$std.param: nope}
`;
    await expect(render(src)).resolves.toBe(`seed: 41   # 状態
missing: 41
`);
  });

  it('前置きより前に書かれたデータのキーも、コメントごとその場に残る', async () => {
    const src = `name: api   # 先
$let:
  x: 1
v: \${x}   # 後
`;
    await expect(render(src)).resolves.toBe(`name: api   # 先
v: 1   # 後
`);
  });

  it('入れ子の前置きも内側へ降りる', async () => {
    const src = `$let:
  base: 10
inner:   # 内側
  $let:
    y: \${base + 1}
  z: \${y + base}
`;
    await expect(render(src)).resolves.toBe(`inner:   # 内側
  z: 21
`);
  });

  it('残りが主形の前置きは島として置換される', async () => {
    const src = `name: api   # 残る
size:
  $let:
    n: 3
  $if: \${n > 2}
  $then: big
  $else: small
`;
    await expect(render(src)).resolves.toBe(`name: api   # 残る
size:
  big
`);
  });

  it('フロー形式の前置きは島として置換される', async () => {
    await expect(render('{$let: {x: 1}, a: "${x}"}\n')).resolves.toBe(stringify({ a: 1 }));
    const src = `outer: {$let: {y: 2}, a: "\${y}"} # 行内
`;
    await expect(render(src)).resolves.toBe(`outer: {"a":2} # 行内
`);
  });

  it('シーケンスの標識と同じ行の前置きは、その要素ごと島として置換される', async () => {
    const src = `services:
- $let: {port: 8080}
  name: web   # 消える
  port: \${port}
- name: db   # 残る
`;
    await expect(render(src)).resolves.toBe(`services:
- name: web
  port: 8080
- name: db   # 残る
`);
  });
});

describe('形が合わない場合は置換の退化', () => {
  it('前置きの $with の節が本体を打ち切ると、島の置換に退化する', async () => {
    const src = `$with:
  throw:
    $fn: m
    $body: caught \${m}
a: {$.throw: boom}   # 消える
`;
    await expect(render(src)).resolves.toBe(stringify('caught boom'));
  });

  it('選択が島の外に漏れて文書が分岐したら、文書全体の再直列化に退化する', async () => {
    // データ位置では島自身が作用境界なので選択は漏れない（tests/eval.test.ts の
    // 「データ文脈では最も外側の $ 式だけが境界になる」）。漏れるのは $do の中である。
    const src = `$std.list:
  $do:
  - a: {$std.each: [1, 2]}
`;
    await expect(render(src)).resolves.toBe(stringify([{ a: 1 }, { a: 2 }]));
  });

  it('文書全体が計算なら結果の直列化になる', async () => {
    const src = `$let:
  x: 1
$in:
  a: \${x}
`;
    await expect(render(src)).resolves.toBe(stringify({ a: 1 }));
  });
});
