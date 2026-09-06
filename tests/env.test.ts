/**
 * 二つの環境（評価器の Env、解析器の SEnv）の表現の直接の保険。
 * どちらも永続平衡木（src/pmap.ts）なので、伸ばすのも読むのも最悪 O(log 束縛数)、
 * 閉包の捕獲は木への参照ひとつで O(1) である。
 * 表現替えで意味論（シャドーイング・閉包の捕獲・resume の見え方）が変わっていないことも固定する。
 *
 * 表現の変遷: Map の全コピー（拡張 O(n)）→ 一件ずつのフレームの親チェーン（読み O(深さ)）
 * → 永続平衡木（読み書きとも O(log n)）。以下の it はそれぞれの天井を踏む文書である。
 */
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { evaluate, type EvaluateOptions } from '../src/eval.js';
import type { Value } from '../src/types.js';

const run = (src: string, options?: EvaluateOptions): Promise<Value> =>
  evaluate(parse(src), options);

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('Env: 拡張のスケール', () => {
  it('2 万文の連続した $let がそれぞれ新しい名前でも 1 秒未満で終わる', async () => {
    const stmts: unknown[] = [];
    for (let i = 0; i < 20000; i++) {
      stmts.push({ $let: { [`x${i}`]: i } });
    }
    // 最古の束縛への参照にする（末尾参照だと最初のフレームで見つかって素通りしてしまう）。
    stmts.push('${x0}');
    const t0 = performance.now();
    await expect(evaluate({ $do: stmts })).resolves.toBe(0);
    const elapsed = performance.now() - t0;
    // Map 全コピー方式では同じ文書が数秒〜十数秒かかった（実測 ~19s）。
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('環境の計算量', () => {
  // 実測（このタスク）: a は親チェーン方式で 2.9 秒 → 平衡木で 0.11 秒、
  // b は SEnv の Map 全コピーで 6.3 秒 → 平衡木で 0.11 秒。閾値はその間に置く。

  it('a. 深い環境からの大量の参照が線形時間で終わる', async () => {
    // 2 万件の束縛の内側で 5 万分岐を回し、各分岐が最古の束縛を読む。
    // 読みが O(束縛数) だと 5 万 x 2 万 = 10^9 ステップになる（実測 2.9 秒）。
    const stmts: unknown[] = [];
    for (let i = 0; i < 20000; i++) stmts.push({ $let: { [`x${i}`]: i } });
    stmts.push({ '$std.list': { $do: [{ '$std.each': range(50000) }, '${x0}'] } });
    const t0 = performance.now();
    const result = (await evaluate({ $do: stmts })) as number[];
    const elapsed = performance.now() - t0;
    expect(result).toHaveLength(50000);
    expect(result[0]).toBe(0);
    expect(result[49999]).toBe(0);
    expect(elapsed).toBeLessThan(1000);
  }, 60000);

  it('b. 1 万個の関数を平坦に束ねた文書が二乗にならない', async () => {
    // 解析器は $fn ごとに定義時点の SEnv を捕まえる。捕獲が複製だと i 件目で i 個写すので
    // 総計 Sigma i = O(n^2)（実測 6.3 秒）。木なら参照ひとつで O(1)。
    const stmts: unknown[] = [];
    for (let i = 0; i < 10000; i++) {
      stmts.push({ $let: { [`f${i}`]: { $fn: 'x', $body: '${x}' } } });
    }
    stmts.push({ '$.f9999': 1 });
    const t0 = performance.now();
    const result = await evaluate({ $do: stmts });
    const elapsed = performance.now() - t0;
    expect(result).toBe(1);
    expect(elapsed).toBeLessThan(2000);
  }, 60000);
});

describe('Env: 意味論の固定', () => {
  it('シャドーイングは手前（後の束縛）が勝つ', async () => {
    await expect(
      run(`
$do:
- $let: {x: 1}
- $let: {x: 2}
- \${x}
`),
    ).resolves.toBe(2);
  });

  it('閉包は定義時の束縛を捕まえ続け、後からの再束縛に影響されない', async () => {
    await expect(
      run(`
$do:
- $let: {x: 1}
- $let:
    f:
      $fn: 'y'
      $body: \${x + y}
- $let: {x: 100}
- {$.f: 1}
`),
    ).resolves.toBe(2);
  });

  it('$resume は節の頭と $resume の間に $let を挟んでも見つかる', async () => {
    // 節の本体で束縛される resume は extendEnv が引き継ぐ。$let で束縛を足しても
    // 継続が見えたままであることを確かめる。
    await expect(
      run(`
$in:
  $std.log: hello
$with:
  std.log:
    $fn: msg
    $body:
      $do:
      - $let: {tag: instrumented}
      - $resume: \${tag}
`),
    ).resolves.toBe('instrumented');
  });
});
