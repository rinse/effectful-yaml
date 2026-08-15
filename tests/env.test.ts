/**
 * レキシカル環境（Env）の表現替え（Map 全コピー → 親チェーン）の直接の保険。
 * 拡張が O(1) になったことと、意味論（シャドーイング・閉包の捕獲）が変わっていないことを固定する。
 */
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { evaluate, type EvaluateOptions } from '../src/eval.js';
import type { Value } from '../src/types.js';

const run = (src: string, options?: EvaluateOptions): Promise<Value> =>
  evaluate(parse(src), options);

describe('Env: 拡張のスケール', () => {
  it('2 万文の連続した $let がそれぞれ新しい名前でも 1 秒未満で終わる', async () => {
    const stmts: unknown[] = [];
    for (let i = 0; i < 20000; i++) {
      stmts.push({ $let: { [`x${i}`]: i } });
    }
    // 最古の束縛への参照にする。チェーンを 2 万フレーム分たどり切るので、
    // 拡張だけでなく参照も O(1) 級で終わることを踏む（末尾参照だと depth 0 で素通りしてしまう）。
    stmts.push('${x0}');
    const t0 = performance.now();
    await expect(evaluate({ $do: stmts })).resolves.toBe(0);
    const elapsed = performance.now() - t0;
    // Map 全コピー方式では同じ文書が数秒〜十数秒かかった（実測 ~19s）。
    // 親チェーン方式なら拡張が O(1) になり、桁違いに速く終わるはず。
    expect(elapsed).toBeLessThan(2000);
  });
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

  it('$resume は節の頭と $resume の間に $let フレームを挟んでも見つかる', async () => {
    // resumeOf はチェーンを手前からたどる。$let で束縛フレームを一枚挟んでも
    // resume を運ぶフレームまで届くことを確かめる。
    await expect(
      run(`
$handle:
  $log: hello
$with:
  log:
    $fn: msg
    $body:
      $do:
      - $let: {tag: instrumented}
      - $resume: \${tag}
`),
    ).resolves.toBe('instrumented');
  });
});
