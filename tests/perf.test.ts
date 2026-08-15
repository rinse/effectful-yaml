/**
 * 規模に対する耐性。表現（Comp）が深さを JS のスタックへ漏らしていないことを固定する。
 * 修正前はいずれも RangeError: Maximum call stack size exceeded で落ちた。
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
