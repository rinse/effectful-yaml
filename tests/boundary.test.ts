/**
 * 境界に達した選択と、評価前の名前の検査。
 * 仕様: docs/grammar/effects.md「作用境界」「合成・部分処理・境界」、docs/grammar/checks.md「作用の推論」、docs/grammar/values.md「環境と名前の解決」
 * 「ホストの値」、docs/usage.md「エラー」。
 */
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { evaluate, type EvaluateOptions } from '../src/eval.js';
import { EffectfulYamlError, type Value } from '../src/types.js';

const run = (src: string, options?: EvaluateOptions): Promise<Value> =>
  evaluate(parse(src), options);

/** 拒否されたことを前提に、そのエラーを取り出す（メッセージと位置の両方を見るため）。 */
async function failure(src: string, options?: EvaluateOptions): Promise<EffectfulYamlError> {
  try {
    await run(src, options);
  } catch (e) {
    return e as EffectfulYamlError;
  }
  throw new Error('expected a rejection');
}

const UNHANDLED = 'unhandled choice: $std.each reached the boundary; no enclosing handler handles std.each';

describe('境界に達した選択', () => {
  it('選ばれなかった分岐の選択は起きない', async () => {
    await expect(run('{$if: false, $then: {$std.each: [1, 2]}, $else: 7}')).resolves.toBe(7);
  });

  it('ハンドラに捕まらずに境界へ達した $std.each はエラーになる', async () => {
    const e = await failure('a:\n  b: {$std.each: [1, 2]}\n');
    expect(e.message).toContain(UNHANDLED);
    expect(e.message).toMatch(/\(at a\.b\)$/);
    expect(e.path).toBe('a.b');
  });

  it('$std.where の打ち切りも、展開の std.each がそのまま境界へ達し、文言は書いた形 $std.where を名乗る', async () => {
    const e = await failure('a:\n  b: {$std.where: false}\n');
    expect(e.message).toContain('unhandled choice: $std.where reached the boundary');
    expect(e.path).toBe('a.b');
  });

  it('$for の選択が境界へ達すると、文言は書いた形と束縛名を名乗る', async () => {
    const e = await failure('a:\n  $for: {x: [1, 2]}\n  v: ${x}\n');
    expect(e.message).toContain("unhandled choice: $for 'x' reached the boundary");
    expect(e.path).toBe('a');
  });

  it('文書全体が境界のときは位置が付かない', async () => {
    const e = await failure('{$std.each: [1, 2]}');
    expect(e.message).toContain(UNHANDLED);
    expect(e.path).toBeUndefined();
  });

  it('選択のハンドラで包めば値になる', async () => {
    await expect(
      run('a:\n  b: {$handler: "${std.list}", $in: {$std.each: [1, 2]}}\n'),
    ).resolves.toEqual({
      a: { b: [1, 2] },
    });
    await expect(run('{$handler: "${std.first}", $in: {$std.each: [1, 2]}}')).resolves.toBe(1);
  });

  it('$std.each の節を持つ $handler も選択を処理する', async () => {
    await expect(
      run(`
$in: {$std.each: [1, 2]}
$handler:
  std.each: {$fn: xs, $body: caught}
`),
    ).resolves.toBe('caught');
  });
});

describe('実行時に決まる呼び先の選択', () => {
  const doc = (head: string): string => `
${head}
$in:
  $do:
  - $let:
      fns:
        pick:
          $fn: x
          $body:
            $std.each:
            - \${x}
            - \${x + 1}
  - $let:
      f:
        $std.lookup:
          in: \${fns}
          key: pick
  - {$.f: 10}
`;

  it('$std.lookup で取り出した関数の本体の選択も、std.list のハンドラの下なら値になる', async () => {
    await expect(run(doc('$handler: "${std.list}"'))).resolves.toEqual([10, 11]);
  });

  it('選択を処理しないハンドラで包んでも、選択は透過して境界に達しエラーになる', async () => {
    // 部分処理（grammar/effects.md「合成・部分処理・境界」）：ハンドラは節に挙げた演算だけを取り除く。
    // 状態のハンドラは std.each を挙げないので、選択はそのまま境界へ抜ける。
    const e = await failure(doc('$handler: {$std.state: {}}'));
    expect(e.message).toContain(UNHANDLED);
  });
});

describe('評価前の名前の検査', () => {
  /** 呼ばれたら記録するホスト演算。評価が始まったかどうかの証拠にする。 */
  const marking = (): { calls: Value[]; ops: EvaluateOptions['ops'] } => {
    const calls: Value[] = [];
    return { calls, ops: { 'log.mark': (v) => (calls.push(v), null) } };
  };

  it('マッピング経由で呼ぶ関数の本体がホストの演算へ閉包を渡す形も、評価前に拒否される', async () => {
    const { calls, ops } = marking();
    await expect(
      run(
        `
$do:
- $let:
    helpers:
      send:
        $fn: f
        $body: {$vault.write: '\${f}'}
- {$log.mark: before}
- {$.helpers.send: {$fn: x, $body: 1}}
`,
        { ops: { ...ops, 'vault.write': () => null } },
      ),
    ).rejects.toThrow('a function value cannot be passed to a host operation: $vault.write');
    expect(calls).toEqual([]);
  });

  it('状態のセルを経由して呼ぶ関数の本体がホストの演算へ閉包を渡す形も、評価前に拒否される', async () => {
    // 呼び先が実行時のデータから決まる経路。関数値の流れの検査はセルを通る経路も数えるので、
    // ホスト演算が一つも走らないうちに拒否される。
    const { calls, ops } = marking();
    await expect(
      run(
        `
$do:
- {$log.mark: before}
- $std.set:
    f:
      $fn: x
      $body: {$vault.write: '\${x}'}
- $let:
    g: {$std.get: f}
- {$.g: {$fn: y, $body: 1}}
`,
        { ops: { ...ops, 'vault.write': () => null } },
      ),
    ).rejects.toThrow('a function value cannot be passed to a host operation: $vault.write');
    expect(calls).toEqual([]);
  });

  it('初期環境に無い束縛名の呼び出しは、実行が到達しない位置にあっても評価前に拒否される', async () => {
    // 検査は出現主義なので、選ばれない分岐の呼び出しも数える。
    const { calls, ops } = marking();
    await expect(
      run(
        `
$do:
- {$log.mark: before}
- $if: true
  $then: safe
  $else: {$nope.op: 1}
`,
        { ops },
      ),
    ).rejects.toThrow('undefined reference: nope');
    expect(calls).toEqual([]);
  });

  it('std. の綴り違いは、先頭区画と違って評価時のパスの解決のエラーになる', async () => {
    // std は初期環境の普通の束縛であり $let で隠せるので（grammar/values.md「環境と名前の解決」）、
    // std.rnge が解決するかどうかは静的に決まらない。評価前に見られるのは先頭区画だけで、
    // 残りの区画がマッピングに無いことは評価時にエラーの語彙で報告される
    // （grammar/syntax.md「呼び出し」）。名前空間ごと免除されるのではない。
    const { calls, ops } = marking();
    await expect(
      run('$do:\n- {$log.mark: before}\n- {$std.rnge: 3}\n', { ops }),
    ).rejects.toThrow("missing key 'rnge'");
    expect(calls).toEqual(['before']);
    await expect(run('{$std.range: 3}')).resolves.toEqual([0, 1, 2]);
  });

  it('登録すれば通る', async () => {
    await expect(
      run(
        `
$do:
- $let:
    helpers:
      read:
        $fn: key
        $body: {$vault.read: '\${key}'}
- {$.helpers.read: db/password}
`,
        { ops: { 'vault.read': (k) => `secret(${String(k)})` } },
      ),
    ).resolves.toBe('secret(db/password)');
  });

  it('自己適用は関数値の流れの検査が評価前に拒否する', async () => {
    await expect(
      run(`
$do:
- $let:
    selfapp:
      $fn: g
      $body: {$.g: 1}
- $.selfapp: \${selfapp}
`),
    ).rejects.toThrow(/self-application detected: .*\$do\[0\]\.\$let\.selfapp/);
  });

  it('境界へ達したローカル作用は、パスの解決のエラーではなく脱出として報告される', async () => {
    await expect(
      run(`
$let:
  f:
    $in: \${throw}
    $handler:
      throw:
        $fn: msg
        $body: caught \${msg}
$in:
  $.f: hi
`),
    ).rejects.toThrow(/local effect 'throw' escaped its handler \(declared at .+\)/);
  });
});

describe('$do の文脈の導入と節の名前', () => {
  it('$in を省いた $handler の節は、後続の文に現れたホストの演算を横取りする', async () => {
    await expect(
      run(
        `
$do:
- $handler:
    vault.read: {$fn: k, $body: stub}
- {$vault.read: db/password}
`,
        { ops: { 'vault.read': () => 'host' } },
      ),
    ).resolves.toBe('stub');
  });

  it('$in を省いた $handler の節が選択を処理すれば、選択は境界へ達しない', async () => {
    await expect(
      run(`
$do:
- $handler:
    std.each: {$fn: xs, $body: first}
- {$std.each: [a, b]}
`),
    ).resolves.toBe('first');
  });

  it('文脈を導入する文があっても、残りの文の名前は数え落とされない', async () => {
    for (const form of [
      '$handler: {$std.state: {n: 0}}',
      '$handler: {throw: {$fn: m, $body: x}}',
    ]) {
      const calls: Value[] = [];
      await expect(
        run(
          `
$do:
- ${form}
- {$log.mark: before}
- {$vault.read: db/password}
`,
          { ops: { 'log.mark': (v) => (calls.push(v), null) } },
        ),
      ).rejects.toThrow('undefined reference: vault');
      expect(calls).toEqual([]);
    }
  });

  it('文脈の導入が足す名前（節の本体と $handler の式）も数える', async () => {
    for (const form of [
      '$handler: {$std.state: {n: {$vault.read: seed}}}',
      '$handler: {throw: {$fn: m, $body: {$vault.read: seed}}}',
    ]) {
      await expect(
        run(`
$do:
- ${form}
- done
`),
      ).rejects.toThrow('undefined reference: vault');
    }
  });

  it('文の位置の外に置いた $handler でも、その式の中まで検査が降りる', async () => {
    const doc = `
$do:
- $let:
    x:
      $handler: {$std.state: {n: {$vault.read: seed}}}
      $in: {$std.get: n}
- \${x}
`;
    await expect(run(doc)).rejects.toThrow('undefined reference: vault');
    await expect(run(doc, { ops: { 'vault.read': () => 7 } })).resolves.toBe(7);
  });
});

describe('走査の規模', () => {
  it('1 段に呼び出しが複数あっても、走査が爆発しない', async () => {
    // 評価前の走査は各構文を一度だけ見るので、入れ子の深さに対して線形である。
    let body: unknown = '${x}';
    for (let i = 0; i < 20; i++) {
      body = {
        $do: [
          { $let: { f: { $fn: 'x', $body: body } } },
          { $if: false, $then: { '$.f': 1 }, $else: { '$.f': 2 } },
        ],
      };
    }
    await expect(evaluate(body)).resolves.toBe(2);
  });

  it(
    '引数にインラインの関数を渡す呼び出しが 1 段に複数あっても爆発しない',
    async () => {
      let body: unknown = 'leaf';
      for (let i = 0; i < 18; i++) {
        const arg = (): unknown => ({ $fn: 'y', $body: 'leaf' });
        body = {
          $do: [
            { $let: { f: { $fn: 'x', $body: body } } },
            { $if: false, $then: { '$.f': arg() }, $else: { '$.f': arg() } },
          ],
        };
      }
      await expect(evaluate(body)).resolves.toBe('leaf');
    },
    1000,
  );
});
