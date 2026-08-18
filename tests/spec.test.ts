/**
 * 受け入れテスト：docs/grammar.md（草案 0.4）の「用例」節に書かれた文書が、
 * そのままの入力・パラメータでページに明記された結果になることを独立に検証する。
 *
 * 期待値はドキュメントの記述をそのまま転記する。実装の挙動に合わせて曲げない。
 *
 * docs/reference/ の用例は、ページ自体が草案 0.3 のまま別タスクで改稿中なので対象にしない。
 * 改稿が済んだら、同じ形でこのファイルに足すこと。
 */
import { describe, expect, it } from 'vitest';
import { evaluateYaml, type Value } from '../src/index.js';

interface SpecCase {
  readonly name: string;
  readonly yaml: string;
  readonly params?: Record<string, Value>;
  readonly ops?: Record<string, (arg: Value) => Value | Promise<Value>>;
  readonly expected: Value;
  readonly expectedLogs?: readonly Value[];
  /** toEqual はキー順を見ないので、「文書順に集める」を確かめたいときだけ指定する。 */
  readonly expectedKeyOrder?: readonly string[];
}

const cases: readonly SpecCase[] = [
  {
    name: '値だけの文書',
    yaml: `greeting: hello`,
    expected: { greeting: 'hello' },
  },
  {
    name: '$collect の基本形（各要素を二重にする）',
    yaml: `
$collect: [1, 2, 3]
$with:
  $fn: x
  $body:
  - \${x}
  - \${x}
`,
    expected: [1, 1, 2, 2, 3, 3],
  },
  {
    name: '選択の基本形（18 要素版：末尾が $std.each）',
    yaml: `
$do:
- $let:
    x: {$std.each: [a, b, c]}
    y: {$std.each: [x, y, z]}
- $std.each:
  - \${x}
  - \${y}
`,
    expected: ['a', 'x', 'a', 'y', 'a', 'z', 'b', 'x', 'b', 'y', 'b', 'z', 'c', 'x', 'c', 'y', 'c', 'z'],
  },
  {
    name: '選択の基本形（9 ペア版：末尾が literal なリスト）',
    yaml: `
$do:
- $let:
    x: {$std.each: [a, b, c]}
    y: {$std.each: [x, y, z]}
- - \${x}
  - \${y}
`,
    expected: [
      ['a', 'x'], ['a', 'y'], ['a', 'z'],
      ['b', 'x'], ['b', 'y'], ['b', 'z'],
      ['c', 'x'], ['c', 'y'], ['c', 'z'],
    ],
  },
  {
    name: '打ち切りつきの選択（$std.where によるリスト内包表記）',
    yaml: `
$do:
- $let:
    x: {$std.each: [1, 2, 3]}
    y: {$std.each: [1, 2, 3]}
- $std.where: \${x < y}
- - \${x}
  - \${y}
`,
    expected: [[1, 2], [1, 3], [2, 3]],
  },
  {
    name: 'パラメータと条件分岐',
    yaml: `
server:
  host: {$std.param: db_host}
  port: {$std.param: db_port, $default: 5432}
  tls:
    $if: {$std.param: use_tls}
    $then:
      cert: /etc/ssl/cert.pem
    $else: null
`,
    params: { db_host: 'example.com', use_tls: false },
    expected: { server: { host: 'example.com', port: 5432, tls: null } },
  },
  {
    name: '分岐を貫く状態（連番の採番）',
    yaml: `
$do:
- $std.set: {n: 0}
- $let:
    name: {$std.each: [web, db, cache]}
    id: {$std.get: n}
- $std.set:
    n: \${id + 1}
- name: \${name}
  id: \${id}
`,
    expected: [
      { name: 'web', id: 0 },
      { name: 'db', id: 1 },
      { name: 'cache', id: 2 },
    ],
  },
  {
    name: 'マッピングの生成と変換',
    yaml: `
$std.mapping:
  $do:
  - $let:
      e: {$std.each: {web: 80, db: 5432}}
  - key: svc-\${e.key}
    value: \${e.value}
`,
    expected: { 'svc-web': 80, 'svc-db': 5432 },
    expectedKeyOrder: ['svc-web', 'svc-db'],
  },
  {
    name: '欠落するデータの剪定（$std.prune）',
    yaml: `
$std.list:
  $do:
  - $let:
      row:
        $std.each:
        - {date: d1, code: c1}
        - {date: d2}
        - {date: d3, code: c3}
  - date: \${row.date}
    code:
      $std.prune: \${row.code}
`,
    expected: [
      { date: 'd1', code: 'c1' },
      { date: 'd3', code: 'c3' },
    ],
  },
  {
    name: '回数つきの unfold（$std.range + $collect + $std.state）',
    yaml: `
$std.state: {acc: 1}
$in:
  $collect: {$std.range: 5}
  $with:
    $fn: _
    $body:
      $do:
      - $let:
          v: {$std.get: acc}
      - $std.set:
          acc: \${v * 2}
      - - \${v}
`,
    expected: [1, 2, 4, 8, 16],
  },
  {
    name: '関数と合成（$pipe）',
    yaml: `
$do:
- $let:
    double:
      $fn: x
      $body: \${x * 2}
    succ:
      $fn: x
      $body: \${x + 1}
- $pipe: 20
  $through:
  - \${double}
  - \${succ}
`,
    expected: 41,
  },
  {
    name: '失敗の捕捉（$handle で std.fail を捕まえて既定値に置き換える）',
    yaml: `
port:
  $handle:
    $do:
    - $let:
        p: {$std.param: port, $default: 0}
    - $if: \${p <= 0 || p > 65535}
      $then:
        $std.fail: invalid port \${p}
      $else: \${p}
  $with:
    std.fail:
      $fn: msg
      $body:
        $do:
        - $std.log: \${msg}
        - 5432
`,
    expected: { port: 5432 },
    expectedLogs: ['invalid port 0'],
  },
  {
    name: '最初に成功する分岐（$std.first、パラメータ未指定で既定値 info）',
    yaml: `
log_level:
  $std.first:
    $do:
    - $let:
        v: {$std.each: [{$std.param: log_level, $default: null}, {$std.param: fallback_log_level, $default: null}, info]}
    - $std.where: \${v != null}
    - \${v}
`,
    expected: { log_level: 'info' },
  },
];

describe('grammar.md 用例（値の一致）', () => {
  it.each(cases)('$name', async (c) => {
    const logs: Value[] = [];
    const result = await evaluateYaml(c.yaml, {
      params: c.params,
      ops: c.ops,
      onLog: (v) => logs.push(v),
    });
    expect(result).toEqual(c.expected);
    if (c.expectedLogs !== undefined) {
      expect(logs).toEqual(c.expectedLogs);
    }
    if (c.expectedKeyOrder !== undefined) {
      expect(Object.keys(result as object)).toEqual(c.expectedKeyOrder);
    }
  });
});

describe('grammar.md 用例（そのほかの記述）', () => {
  it('$op の慣用：長い名前の演算に短いローカル名を付ける', async () => {
    const ops = { 'vault.secrets.read': (arg: Value) => `secret:${String(arg)}` };
    const viaLocalName = await evaluateYaml(
      `
$do:
- $let:
    read: {$op: vault.secrets.read}
- {$.read: db/password}
`,
      { ops },
    );
    const direct = await evaluateYaml('{$vault.secrets.read: db/password}', { ops });
    expect(viaLocalName).toEqual(direct);
    expect(viaLocalName).toBe('secret:db/password');
  });

  it('失敗を null で埋めたいときは $std.prune を $std.opt に替える', async () => {
    await expect(
      evaluateYaml(`
$std.list:
  $do:
  - $let:
      row:
        $std.each:
        - {date: d1, code: c1}
        - {date: d2}
  - date: \${row.date}
    code:
      $std.opt: \${row.code}
`),
    ).resolves.toEqual([
      { date: 'd1', code: 'c1' },
      { date: 'd2', code: null },
    ]);
  });

  it('Haskell との対応：束縛を持たない $do の文の並びは f >> g >> h である', async () => {
    await expect(evaluateYaml('{$do: [f, g, h]}')).resolves.toBe('h');
  });
});

// -----------------------------------------------------------------------------
// 期待値が「エラーになる」であるもの
// -----------------------------------------------------------------------------
interface ErrorCase {
  readonly name: string;
  readonly yaml: string;
  readonly params?: Record<string, Value>;
  readonly messagePattern: RegExp;
}

const errorCases: readonly ErrorCase[] = [
  {
    name: '捕捉されない std.fail は文書全体のエラーになる',
    yaml: `
$do:
- $let:
    p: {$std.param: port, $default: 0}
- $if: \${p <= 0}
  $then:
    $std.fail: invalid port \${p}
  $else: \${p}
`,
    messagePattern: /invalid port 0/,
  },
  {
    name: '閉包が境界の外へ出て文書の値に残るのはエラー',
    yaml: `{$fn: x, $body: '\${x}'}`,
    messagePattern: /function value cannot escape/,
  },
  {
    name: '$std.range の引数が自然数でなければエラー',
    yaml: `{$std.range: -1}`,
    messagePattern: /\$std\.range requires a natural number/,
  },
  {
    name: '予約されていないドットなしの $ キーはエラー（旧記法の廃止）',
    yaml: `{$each: [1, 2]}`,
    messagePattern: /unreserved \$ key: \$each/,
  },
];

describe('grammar.md 用例（エラーになる）', () => {
  it.each(errorCases)('$name', async (c) => {
    await expect(evaluateYaml(c.yaml, { params: c.params })).rejects.toThrow(c.messagePattern);
  });
});
