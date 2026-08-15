/**
 * 規模に対する耐性。
 * - 「大きな文書」: 表現（Comp）が深さを JS のスタックへ漏らしていないことを固定する。
 *   修正前はいずれも RangeError: Maximum call stack size exceeded で落ちた。
 * - 「逐次組み立ての計算量」: collectChoice の each 節と compose のリスト/マッピングが
 *   毎ステップでスプレッドコピーせず O(1) で積んでいることを固定する。
 *   修正前は分岐数・要素数に対して O(n^2) で、3 万台ですでに数秒〜10 秒、
 *   10 万では 40 秒のタイムアウトでも終わらなかった（詳細は各 it の直前のコメント）。
 */
import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/eval.js';
import type { Value } from '../src/types.js';

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('大きな文書', () => {
  it('$list の中の $each が 8000 分岐しても溢れない', async () => {
    // 8000 要素のデータリスト（compose の逐次組み立て）と、8000 分岐の畳み込みの両方を踏む。
    await expect(evaluate({ $list: { $each: range(8000) } })).resolves.toEqual(range(8000));
  });

  it('8000 分岐がそれぞれ $log しても溢れない', async () => {
    // $log の節はその場で resume するので、handleOps が入れ子になっていると溢れる。
    const seen: Value[] = [];
    await expect(
      evaluate(
        { $list: { $do: [{ $let: { x: { $each: range(8000) } } }, { $log: '${x}' }, '${x}'] } },
        { onLog: (v) => seen.push(v) },
      ),
    ).resolves.toEqual(range(8000));
    expect(seen).toEqual(range(8000));
  });

  it('8000 分岐が状態を貫流させても溢れない', async () => {
    // 選択（$each）は $list が、状態（$get/$set）はその外側の既定ハンドラが処理する。
    // 状態は分岐をまたいで文書順に貫流するので、最後の分岐の値は 8000 になる。
    const doc = {
      $do: [
        { $set: { n: 0 } },
        {
          $list: {
            $do: [
              { $each: range(8000) },
              { $let: { v: { $get: 'n' } } },
              { $set: { n: '${v + 1}' } },
              { $get: 'n' },
            ],
          },
        },
      ],
    };
    await expect(evaluate(doc)).resolves.toEqual(range(8000).map((i) => i + 1));
  });

  it('2 万文の $do が溢れずにカウンタを数え切る', async () => {
    // 1 万回ぶんの「読んで足して書く」= 2 万文。状態の演算は 2 万回を超える。
    const stmts: unknown[] = [{ $set: { n: 0 } }];
    for (let i = 0; i < 10000; i++) {
      stmts.push({ $let: { v: { $get: 'n' } } }, { $set: { n: '${v + 1}' } });
    }
    stmts.push({ $get: 'n' });
    await expect(evaluate({ $do: stmts })).resolves.toBe(10000);
  });

  it('2 万文の純粋な $do が溢れない', async () => {
    await expect(evaluate({ $do: range(20000) })).resolves.toBe(19999);
  });
});

describe('逐次組み立ての計算量', () => {
  // 各 it に明示したタイムアウト（5 秒）自体が回帰検知になる。修正後は数百 ms で終わる一方、
  // 修正前は 3 万〜8000 要素ですでに数秒〜10 秒かかり、10 万要素は 40 秒でも終わらなかった
  // （このタスクの計測: collectChoice each 3.2 万分岐で 9.4 秒・10 万分岐は 40 秒でタイムアウト、
  //  compose のリスト 3.2 万要素で 4.6 秒・10 万要素は 40 秒でタイムアウト、
  //  compose のマッピング 8000 キーで 9.4 秒）。

  it('$list: {$each: ...} が 10 万分岐でも妥当な時間で終わる', async () => {
    await expect(evaluate({ $list: { $each: range(100000) } })).resolves.toEqual(range(100000));
  }, 5000);

  it('10 万要素のデータリストのリテラルが妥当な時間で終わる', async () => {
    // 要素に補間式を持たせ、compose が interpolate（評価経路）を実際に通ることを確認する。
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
