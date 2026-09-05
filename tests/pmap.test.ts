/**
 * 永続平衡木（src/pmap.ts）の単体テスト。
 * 見るのは三つ。読み書きの意味、挿入順によらずバランスが保たれること（＝退化しないこと）、
 * そして undefined を値として入れても壊れないこと。
 */
import { describe, expect, it } from 'vitest';
import { empty, get, insert, inspect, type PMap } from '../src/pmap.js';

const N = 100000;
/** 辞書順で単調増加する鍵。String(i) は "10" < "2" なので昇順の退化を作れない。 */
const key = (i: number): string => `k${String(i).padStart(6, '0')}`;

const build = (order: readonly number[]): PMap<number> => {
  let m: PMap<number> = empty;
  for (const i of order) m = insert(m, key(i), i);
  return m;
};

const ascending = Array.from({ length: N }, (_, i) => i);
const descending = [...ascending].reverse();
const shuffled = (() => {
  // 決定的な擬似乱数（テストを再現可能にする）。
  const out = [...ascending];
  let s = 12345;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
})();

describe('PMap: 大量挿入', () => {
  for (const [name, order] of [
    ['昇順', ascending],
    ['降順', descending],
    ['ランダム順', shuffled],
  ] as const) {
    it(`${name}に 10 万件入れても全件引ける`, () => {
      const t0 = performance.now();
      const m = build(order);
      const elapsed = performance.now() - t0;
      // 10 万回の expect は測定を覆い隠すほど遅いので、食い違いだけ集めて一度に見る。
      const wrong = ascending.filter((i) => get(m, key(i)) !== i);
      expect(wrong).toEqual([]);
      expect(get(m, 'k999999')).toBeUndefined();
      // 回転しない素朴な BST なら昇順・降順で高さ 10 万に退化し、この規模は終わらない。
      expect(elapsed).toBeLessThan(3000);
    });
  }

  it('昇順 10 万件でも高さが log に収まり、不変条件が全ノードで成り立つ', () => {
    const { size, height } = inspect(build(ascending));
    expect(size).toBe(N);
    // delta = 3 の重み条件が保証する上界は 2.41 * log2 n ≒ 40（実測の高さは 22）。退化なら 10 万。
    expect(height).toBeLessThanOrEqual(3 * Math.log2(N));
  });
});

describe('PMap: 意味の固定', () => {
  it('同じキーの再挿入は上書きで、件数は増えない', () => {
    const m = insert(insert(insert(empty as PMap<string>, 'b', '1'), 'a', 'x'), 'b', '2');
    expect(get(m, 'b')).toBe('2');
    expect(inspect(m).size).toBe(2);
  });

  it('挿入は元の木を変えない（永続）', () => {
    const before = build([1, 2, 3]);
    const after = insert(before, key(4), 4);
    expect(get(before, key(4))).toBeUndefined();
    expect(get(after, key(4))).toBe(4);
    expect(inspect(before).size).toBe(3);
  });

  it('undefined を値として束縛できる（件数で確かめる。get では未束縛と区別できない）', () => {
    const m = insert(insert(empty as PMap<number | undefined>, 'a', 1), 'b', undefined);
    expect(inspect(m).size).toBe(2);
    expect(get(m, 'b')).toBeUndefined();
    // 同じキーへの再挿入なので増えない＝ノードとしては確かに存在している。
    expect(inspect(insert(m, 'b', undefined)).size).toBe(2);
    expect(get(insert(m, 'b', 7), 'b')).toBe(7);
  });
});
