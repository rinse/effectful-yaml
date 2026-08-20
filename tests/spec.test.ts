/**
 * 受け入れテスト：docs/grammar.md（草案 0.4）と docs/reference/ の「例」節に書かれた文書が、
 * そのままの入力・パラメータでページに明記された結果になることを独立に検証する。
 *
 * 期待値はドキュメントの記述をそのまま転記する。実装の挙動に合わせて曲げない。
 * ページの例が誤っていて実行結果と食い違う場合も、テストは曲げず、そのまま失敗させて報告する。
 *
 * docs/reference/std.first.md の「展開の概形」節のコードは tests/derivations.test.ts が
 * 別途検証するので、ここには転記しない（形だけを示す断片も対象外）。
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
    name: '欠落するデータの除外（打ち切りの定型）',
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
      $std.opt: \${row.code}
      $default: {$std.where: false}
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
    name: '関数と合成（呼び出しの入れ子）',
    yaml: `
$do:
- $let:
    double:
      $fn: x
      $body: \${x * 2}
    succ:
      $fn: x
      $body: \${x + 1}
- $.succ:
    $.double: 20
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
  {
    name: '$fn の列と部分適用（先頭の引数だけを与えると残りを待つ閉包になる）',
    yaml: `
$do:
- $let:
    add:
      $fn: [a, b]
      $body: \${a + b}
    succ:
      $.add: 1
- $.succ: 41
`,
    expected: 42,
  },
  {
    name: '演算の部分適用（基準 URL を固定した絶対化関数を選択の各分岐に適用する）',
    yaml: `
$std.list:
  $do:
  - $let:
      resolve:
        $fn: [base, path]
        $body:
          $std.resolve:
            base: \${base}
            path: \${path}
  - $let:
      abs:
        $.resolve: https://example.com/articles/index.html
      link: {$std.each: [../images/cover.png, style.css]}
  - $.abs: \${link}
`,
    expected: ['https://example.com/images/cover.png', 'https://example.com/articles/style.css'],
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
  it('長い名前の演算には、引数を素通しする $fn を $let で短い名前に束縛する', async () => {
    const ops = { 'vault.secrets.read': (arg: Value) => `secret:${String(arg)}` };
    const viaLocalName = await evaluateYaml(
      `
$do:
- $let:
    read:
      $fn: key
      $body: {$vault.secrets.read: '\${key}'}
- {$.read: db/password}
`,
      { ops },
    );
    const direct = await evaluateYaml('{$vault.secrets.read: db/password}', { ops });
    expect(viaLocalName).toEqual(direct);
    expect(viaLocalName).toBe('secret:db/password');
  });

  it('失敗を null で埋めたいときは $default を省く', async () => {
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

// -----------------------------------------------------------------------------
// docs/reference/ 用例：カーネル 6（do / let / if / fn / handle / collect）と
// std 17（std.each ほか）の「例」節にある実行可能な用例。
// 期待値・パラメータ・ログはページの記述をそのまま転記する。grammar.md 用例と内容が
// 重なるものもあるが、各ページの記述を独立に固定する目的でそのまま転記する。
// -----------------------------------------------------------------------------
const referenceCases: readonly SpecCase[] = [
  // --- カーネル ---------------------------------------------------------------
  {
    name: 'do.md の例（$do は最後の文の値、途中の $std.log も流れる）',
    yaml: `
$do:
- $std.log: starting
- hello, world
`,
    expected: 'hello, world',
    expectedLogs: ['starting'],
  },
  {
    name: 'let.md の例（後の束縛から先の束縛を参照する）',
    yaml: `
$do:
- $let:
    x: 2
    y: \${x + 1}
- \${x * y}
`,
    expected: 6,
  },
  {
    name: 'if.md の例（$std.param の真偽値で分岐する）',
    yaml: `
tls:
  $if: {$std.param: use_tls}
  $then:
    cert: /etc/ssl/cert.pem
  $else: null
`,
    params: { use_tls: false },
    expected: { tls: null },
  },
  {
    name: 'fn.md の例（$let で束縛した関数を $.名前 で呼ぶ）',
    yaml: `
$do:
- $let:
    double:
      $fn: x
      $body: \${x * 2}
- {$.double: 21}
`,
    expected: 42,
  },
  {
    name: 'fn.md の例（マッピングの中の関数をドット区切りのパスで呼ぶ）',
    yaml: `
$do:
- $let:
    helpers:
      double:
        $fn: x
        $body: \${x * 2}
- {$.helpers.double: 21}
`,
    expected: 42,
  },
  {
    name: 'fn.md の例（引数名の列の部分適用で基準 URL を固定した絶対化関数を作る）',
    yaml: `
$do:
- $let:
    resolve:
      $fn: [base, path]
      $body:
        $std.resolve:
          base: \${base}
          path: \${path}
- $let:
    abs:
      $.resolve: https://example.com/articles/index.html
- $.abs: ../images/cover.png
`,
    expected: 'https://example.com/images/cover.png',
  },
  {
    name: 'handle.md の例（失敗の捕捉：ログを流して既定値に置き換える）',
    yaml: `
port:
  $handle:
    $do:
    - $let:
        p: {$std.param: port, $default: 0}
    - $if: \${p <= 0}
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
    name: 'handle.md の例（ログの計装：捕捉して加工してから呼び直す）',
    yaml: `
$handle:
  $do:
  - $std.log: hello
  - 42
$with:
  std.log:
    $fn: msg
    $body:
      $do:
      - $std.log: 'app: \${msg}'
      - {$resume: null}
`,
    expected: 42,
    expectedLogs: ['app: hello'],
  },
  {
    name: 'collect.md の例（map の形：各要素を二重にする）',
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
    name: 'collect.md の例（filter の形：偶数だけを残す）',
    yaml: `
$collect: [1, 2, 3, 4, 5]
$with:
  $fn: x
  $body:
    $if: \${x % 2 == 0}
    $then:
    - \${x}
    $else: []
`,
    expected: [2, 4],
  },
  {
    name: 'collect.md の例（エントリの列から $into: mapping で組み立てる）',
    yaml: `
$collect:
- {name: web, value: 80}
- {name: db, value: 5432}
$with:
  $fn: e
  $body:
  - key: \${e.name}
    value: \${e.value}
$into: mapping
`,
    expected: { web: 80, db: 5432 },
    expectedKeyOrder: ['web', 'db'],
  },
  // --- std ---------------------------------------------------------------
  {
    name: 'std.each.md の例（二重の選択で全組み合わせを作る）',
    yaml: `
$do:
- $let:
    x: {$std.each: [1, 2]}
    y: {$std.each: [10, 20]}
- \${x + y}
`,
    expected: [11, 21, 12, 22],
  },
  {
    name: 'std.each.md の例（マッピングの分解）',
    yaml: `
$do:
- $let:
    e: {$std.each: {web: 80, db: 5432}}
- \${e.key}
`,
    expected: ['web', 'db'],
  },
  {
    name: 'std.where.md の例（リスト内包表記のガード）',
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
    name: 'std.get.md の例（set した値を get で読む）',
    yaml: `
$do:
- $std.set: {n: 41}
- $let:
    v: {$std.get: n}
- \${v + 1}
`,
    expected: 42,
  },
  {
    name: 'std.set.md の例（複数のセルを一度に書く）',
    yaml: `
$do:
- $std.set:
    n: 1
    m: 2
- $let:
    a: {$std.get: n}
    b: {$std.get: m}
- \${a + b}
`,
    expected: 3,
  },
  {
    name: 'std.list.md の例（sizes を集める）',
    yaml: `
sizes:
  $std.list:
    $do:
    - $let:
        n: {$std.each: [1, 2, 3]}
    - \${n * 10}
`,
    expected: { sizes: [10, 20, 30] },
  },
  {
    name: 'std.log.md の例（ログに流して値はそのまま）',
    yaml: `
$do:
- $std.log: computing
- 42
`,
    expected: 42,
    expectedLogs: ['computing'],
  },
  {
    name: 'std.lower.md の例',
    yaml: `{$std.lower: HELLO}`,
    expected: 'hello',
  },
  {
    name: 'std.upper.md の例',
    yaml: `{$std.upper: hello}`,
    expected: 'HELLO',
  },
  {
    name: 'std.mapping.md の例（svc- マッピングの生成）',
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
    name: 'std.opt.md の例（欠落を null で埋める）',
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
      $std.opt: \${row.code}
`,
    expected: [
      { date: 'd1', code: 'c1' },
      { date: 'd2', code: null },
      { date: 'd3', code: 'c3' },
    ],
  },
  {
    name: 'std.opt.md の例（$default でパスアクセスの欠落を埋める）',
    yaml: `
$do:
- $let:
    spec: {}
- pre:
    $std.opt: \${spec.pre}
    $default: ''
`,
    expected: { pre: '' },
  },
  {
    name: 'std.param.md の例（渡されたパラメータと $default）',
    yaml: `
host: {$std.param: db_host}
port: {$std.param: db_port, $default: 5432}
`,
    params: { db_host: 'example.com' },
    expected: { host: 'example.com', port: 5432 },
  },
  {
    name: 'std.opt.md の例（打ち切りの定型で行ごと削る）',
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
      $std.opt: \${row.code}
      $default: {$std.where: false}
`,
    expected: [
      { date: 'd1', code: 'c1' },
      { date: 'd3', code: 'c3' },
    ],
  },
  {
    name: 'std.range.md の例（自然数を添字のリストに変える）',
    yaml: `{$std.range: 5}`,
    expected: [0, 1, 2, 3, 4],
  },
  {
    name: 'std.range.md の例（回数つきの unfold）',
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
    name: 'std.resolve.md の例（相対参照の解決）',
    yaml: `$std.resolve: {base: https://example.com/a/b/, path: ../c}`,
    expected: 'https://example.com/a/c',
  },
  {
    name: 'std.resolve.md の例（相対リンクをページの URL を基準に絶対化する）',
    yaml: `
$do:
- $let:
    page: https://example.com/articles/index.html
    link: ../images/cover.png
- $std.resolve:
    base: \${page}
    path: \${link}
`,
    expected: 'https://example.com/images/cover.png',
  },
  {
    name: 'std.lookup.md の例（計算したキーで料金表を引く）',
    yaml: `
$do:
- $let:
    prices: {basic: 9, pro: 29, enterprise: 99}
    plan: pro
- $std.lookup:
    in: \${prices}
    key: \${plan}
`,
    expected: 29,
  },
  {
    name: 'std.lookup.md の例（$std.opt の $default と組み合わせた既定値つきの照会）',
    yaml: `
$do:
- $let:
    overrides: {web: {timeout: 30}, db: {timeout: 60}}
    label: cache
- $std.opt:
    $std.lookup:
      in: \${overrides}
      key: \${label}
  $default: {}
`,
    expected: {},
  },
  {
    name: 'std.state.md の例（内側の $std.state は外の状態に触れない）',
    yaml: `
$do:
- $std.set: {n: 100}
- $let:
    inner:
      $std.state: {n: 0}
      $in:
        $do:
        - $std.set: {n: 1}
        - {$std.get: n}
    outer: {$std.get: n}
- inner: \${inner}
  outer: \${outer}
`,
    expected: { inner: 1, outer: 100 },
  },
  {
    name: 'std.state.md の例（貫流：状態が分岐から分岐へ持ち越される）',
    yaml: `
$std.state: {n: 0}
$in:
  $std.list:
    $do:
    - $std.set: {n: 10}
    - $let:
        x: {$std.each: [a, b]}
        i: {$std.get: n}
    - $std.set:
        n: \${i + 1}
    - \${x}\${i}
`,
    expected: ['a10', 'b11'],
  },
  {
    name: 'std.state.md の例（分岐点で分かれる：各分岐が選択時点の状態を引き継ぐ）',
    yaml: `
$std.list:
  $std.state: {n: 0}
  $in:
    $do:
    - $std.set: {n: 10}
    - $let:
        x: {$std.each: [a, b]}
        i: {$std.get: n}
    - $std.set:
        n: \${i + 1}
    - \${x}\${i}
`,
    expected: ['a10', 'b10'],
  },
  {
    name: 'std.state.md の例（分岐ごとに初期化：各分岐が初期値から作り直す）',
    yaml: `
$do:
- $let:
    x: {$std.each: [a, b]}
- $std.state: {n: 0}
  $in:
    $do:
    - $let:
        i: {$std.get: n}
    - $std.set:
        n: \${i + 1}
    - \${x}\${i}
`,
    expected: ['a0', 'b0'],
  },
  {
    name: 'std.state.md の例（連番の採番）',
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
    name: 'std.first.md の例（パラメータ未渡しで info に落ちる、参照ページの 2 分岐版）',
    yaml: `
log_level:
  $std.first:
    $do:
    - $let:
        v: {$std.each: [{$std.param: log_level, $default: null}, info]}
    - $std.where: \${v != null}
    - \${v}
`,
    expected: { log_level: 'info' },
  },
];

describe('docs/reference/ 用例（値の一致）', () => {
  it.each(referenceCases)('$name', async (c) => {
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

const referenceErrorCases: readonly ErrorCase[] = [
  {
    name: 'std.fail.md の例（捕捉されない std.fail は文書全体のエラーになる）',
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
];

describe('docs/reference/ 用例（エラーになる）', () => {
  it.each(referenceErrorCases)('$name', async (c) => {
    await expect(evaluateYaml(c.yaml, { params: c.params })).rejects.toThrow(c.messagePattern);
  });
});
