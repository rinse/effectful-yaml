/**
 * 規模に対する耐性。
 * - 「大きな文書」: 表現（Comp）が深さを JS のスタックへ漏らさない（RangeError にならない）。
 * - 「逐次組み立ての計算量」: collectChoice の each 節とリスト/マッピングのリテラルの評価が
 *   要素を O(1) で積み、分岐数・要素数に対して線形で終わる。
 */
import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/eval.js';
import type { Value } from '../src/types.js';

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('大きな文書', () => {
  it('$std.list の中の $std.each が 8000 分岐しても溢れない', async () => {
    // 8000 要素のデータリストの逐次組み立てと、8000 分岐の畳み込みの両方を踏む。
    await expect(evaluate({ '$std.list': { '$std.each': range(8000) } })).resolves.toEqual(range(8000));
  });

  it('8000 分岐がそれぞれ $std.log しても溢れない', async () => {
    // $std.log の節はその場で resume するので、handleOps が入れ子になっていると溢れる。
    const seen: Value[] = [];
    await expect(
      evaluate(
        { '$std.list': { $do: [{ $let: { x: { '$std.each': range(8000) } } }, { '$std.log': '${x}' }, '${x}'] } },
        { onLog: (v) => seen.push(v) },
      ),
    ).resolves.toEqual(range(8000));
    expect(seen).toEqual(range(8000));
  });

  it('8000 分岐が状態を貫流させても溢れない', async () => {
    // 選択（$std.each）は $std.list が、状態（$std.get/$std.set）はその外側の既定ハンドラが処理する。
    // 状態は分岐をまたいで文書順に貫流するので、最後の分岐の値は 8000 になる。
    const doc = {
      $do: [
        { '$std.set': { n: 0 } },
        {
          '$std.list': {
            $do: [
              { '$std.each': range(8000) },
              { $let: { v: { '$std.get': 'n' } } },
              { '$std.set': { n: '${v + 1}' } },
              { '$std.get': 'n' },
            ],
          },
        },
      ],
    };
    await expect(evaluate(doc)).resolves.toEqual(range(8000).map((i) => i + 1));
  });

  it('2 万文の $do が溢れずにカウンタを数え切る', async () => {
    // 1 万回ぶんの「読んで足して書く」= 2 万文。状態の演算は 2 万回を超える。
    const stmts: unknown[] = [{ '$std.set': { n: 0 } }];
    for (let i = 0; i < 10000; i++) {
      stmts.push({ $let: { v: { '$std.get': 'n' } } }, { '$std.set': { n: '${v + 1}' } });
    }
    stmts.push({ '$std.get': 'n' });
    await expect(evaluate({ $do: stmts })).resolves.toBe(10000);
  });

  it('2 万文の純粋な $do が溢れない', async () => {
    await expect(evaluate({ $do: range(20000) })).resolves.toBe(19999);
  });
});

describe('逐次組み立ての計算量', () => {
  // 線形なら数百 ms で終わる。二乗なら 10 万要素は数十秒かかるので、5 秒のタイムアウトが回帰を検知する。

  it('$std.list: {$std.each: ...} が 10 万分岐でも妥当な時間で終わる', async () => {
    await expect(evaluate({ '$std.list': { '$std.each': range(100000) } })).resolves.toEqual(range(100000));
  }, 5000);

  it('10 万要素のデータリストのリテラルが妥当な時間で終わる', async () => {
    // 要素に補間式を持たせ、リストの評価が interpolate（評価経路）を実際に通ることを確認する。
    const list = range(100000).map((i) => `\${${i} + 1}`);
    await expect(evaluate(list)).resolves.toEqual(range(100000).map((i) => i + 1));
  }, 5000);

  it('数万キーのマッピングのリテラルが妥当な時間で終わり、文書順も保たれる', async () => {
    // 値に演算を含め、評価経路を通す。挿入順（文書順）が実体化後も保たれることも確認する。
    const n = 30000;
    const doc: Record<string, string> = {};
    for (let i = 0; i < n; i++) doc[`k${i}`] = `\${${i} + 1}`;
    const result = (await evaluate(doc)) as Record<string, number>;
    expect(Object.keys(result)).toEqual(Object.keys(doc));
    expect(result['k0']).toBe(1);
    expect(result[`k${n - 1}`]).toBe(n);
  }, 5000);
});

describe('状態の書き込みの計算量', () => {
  it('1 万個の別々のセルへの $std.set が二乗にならない', async () => {
    // 記憶の複製が「$std.set のたびに全セルをコピー」だと、i 個目の書き込みで i 個写すので
    // 総計 Sigma i = O(n^2) になる。永続木なら書き込みごとに O(log n)。
    const stmts: unknown[] = [];
    for (let i = 0; i < 10000; i++) stmts.push({ '$std.set': { [`c${i}`]: i } });
    stmts.push({ '$std.get': 'c0' });
    await expect(evaluate({ $do: stmts })).resolves.toBe(0);
  }, 3000);
});
