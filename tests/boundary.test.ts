/**
 * 境界に達した選択と、評価前の演算の検査。
 * 仕様: docs/grammar.md「作用境界」「作用の推論」「演算」、docs/usage.md「エラー」。
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

const UNHANDLED = 'unhandled choice: $std.each reached the boundary without a handler';

describe('境界に達した選択', () => {
  it('選ばれなかった分岐の選択は起きない', async () => {
    await expect(run('{$if: false, $then: {$std.each: [1, 2]}, $else: 7}')).resolves.toBe(7);
  });

  it('ハンドラに捕まらずに境界へ達した $std.each はエラーになる', async () => {
    const e = await failure('a:\n  b: {$std.each: [1, 2]}\n');
    expect(e.message).toContain(UNHANDLED);
    expect(e.message).toContain('wrap the computation in $std.list, $std.first or $std.mapping');
    expect(e.message).toMatch(/\(at a\.b\)$/);
    expect(e.path).toBe('a.b');
  });

  it('$std.where の打ち切りも、展開の std.each がそのまま境界へ達する', async () => {
    const e = await failure('a:\n  b: {$std.where: false}\n');
    expect(e.message).toContain(UNHANDLED);
    expect(e.path).toBe('a.b');
  });

  it('文書全体が境界のときは位置が付かない', async () => {
    const e = await failure('{$std.each: [1, 2]}');
    expect(e.message).toContain(UNHANDLED);
    expect(e.path).toBeUndefined();
  });

  it('選択のハンドラで包めば値になる', async () => {
    await expect(run('a:\n  b: {$std.list: {$std.each: [1, 2]}}\n')).resolves.toEqual({
      a: { b: [1, 2] },
    });
    await expect(run('{$std.first: {$std.each: [1, 2]}}')).resolves.toBe(1);
  });

  it('$std.each の節を持つ $handle も選択を処理する', async () => {
    await expect(
      run(`
$handle: {$std.each: [1, 2]}
$with:
  std.each: {$fn: xs, $body: caught}
`),
    ).resolves.toBe('caught');
  });
});

describe('実行時に決まる呼び先の選択', () => {
  const doc = (wrapper: string): string => `
${wrapper}
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

  it('$std.lookup で取り出した関数の本体の選択も、$std.list の下なら値になる', async () => {
    await expect(run(doc('$std.list:'))).resolves.toEqual([10, 11]);
  });

  it('包まなければ境界に達してエラーになる', async () => {
    const e = await failure(doc('$std.opt:'));
    expect(e.message).toContain(UNHANDLED);
  });
});

describe('評価前の演算の検査', () => {
  /** 呼ばれたら記録するホスト演算。評価が始まったかどうかの証拠にする。 */
  const marking = (): { calls: Value[]; ops: EvaluateOptions['ops'] } => {
    const calls: Value[] = [];
    return { calls, ops: { 'log.mark': (v) => (calls.push(v), null) } };
  };

  it('マッピング経由で呼ぶ関数の本体の未登録演算も、評価前に拒否される', async () => {
    const { calls, ops } = marking();
    await expect(
      run(
        `
$do:
- $let:
    helpers:
      read:
        $fn: key
        $body: {$vault.read: '\${key}'}
- {$log.mark: before}
- {$.helpers.read: db/password}
`,
        { ops },
      ),
    ).rejects.toThrow('unregistered operation: $vault.read');
    expect(calls).toEqual([]);
  });

  it('状態のセルを経由して呼ぶ関数の本体の未登録演算も、評価前に拒否される', async () => {
    // 呼び先が実行時のデータから決まる経路。演算のサイトの表は出現に対して全域なので、
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
      $body: {$nope.op: '\${x}'}
- $let:
    g: {$std.get: f}
- {$.g: 1}
`,
        { ops },
      ),
    ).rejects.toThrow('unregistered operation: $nope.op');
    expect(calls).toEqual([]);
  });

  it('std. 名前空間の綴り違いも拒否される（既定ハンドラが処理する 6 つだけが免除される）', async () => {
    // ホストは std. 名前空間に登録できないので、免除は既定ハンドラと選択のハンドラが
    // 処理する演算に限る。名前空間ごと免除すると、この文書が実行時まで通ってしまう。
    await expect(run('{$std.rnge: 3}')).rejects.toThrow('unregistered operation: $std.rnge');
    await expect(run('{$std.range: 3}')).resolves.toEqual([0, 1, 2]);
  });

  it('実行が到達しない位置の未登録演算も拒否される', async () => {
    await expect(
      run(`
$if: true
$then: safe
$else: {$nope.op: 1}
`),
    ).rejects.toThrow('unregistered operation: $nope.op');
  });

  it('登録すれば通る', async () => {
    await expect(
      run(`
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

  it('ローカル作用の脱出は未登録演算ではなく脱出として報告される', async () => {
    await expect(
      run(`
$let:
  f:
    $handle: \${throw}
    $with:
      throw:
        $fn: msg
        $body: caught \${msg}
$in:
  $.f: hi
`),
    ).rejects.toThrow(/local effect 'throw' escaped its handler \(declared at .+\)/);
  });
});

describe('$do の文形と節の名前', () => {
  it('$with 文の節に挙げた登録演算は、後続の文に現れても事前検査を通る', async () => {
    await expect(
      run(`
$do:
- $with:
    vault.read: {$fn: k, $body: stub}
- {$vault.read: db/password}
`),
    ).resolves.toBe('stub');
  });

  it('$with 文の節が選択を処理すれば、選択は境界へ達しない', async () => {
    await expect(
      run(`
$do:
- $with:
    std.each: {$fn: xs, $body: first}
- {$std.each: [a, b]}
`),
    ).resolves.toBe('first');
  });

  it('文形の文があっても、残りの文の演算は数え落とされない', async () => {
    for (const form of ['$std.state: {n: 0}', '$with: {other.op: {$fn: m, $body: x}}']) {
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
      ).rejects.toThrow('unregistered operation: $vault.read');
      expect(calls).toEqual([]);
    }
  });

  it('文形が足す演算（節の本体と $std.state の初期値）も数える', async () => {
    for (const form of [
      '$std.state: {n: {$vault.read: seed}}',
      '$with: {other.op: {$fn: m, $body: {$vault.read: seed}}}',
    ]) {
      await expect(
        run(`
$do:
- ${form}
- done
`),
      ).rejects.toThrow('unregistered operation: $vault.read');
    }
  });

  it('文の位置の外の $in なし $std.state も、初期値まで検査が降りる', async () => {
    const doc = `
$do:
- $let:
    x: {$std.state: {n: {$vault.read: seed}}}
- \${x}
`;
    await expect(run(doc)).rejects.toThrow('unregistered operation: $vault.read');
    await expect(run(doc, { ops: { 'vault.read': () => 0 } })).rejects.toThrow(
      /\$std\.state without \$in is only allowed as a statement of \$do/,
    );
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
