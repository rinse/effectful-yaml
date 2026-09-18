/**
 * 受け入れテスト：docs/grammar/（草案 0.14）と docs/reference/ の「例」節に書かれた文書が、
 * そのままの入力でページに明記された結果になることを独立に検証する。
 *
 * 期待値はドキュメントの記述をそのまま転記する。実装の挙動に合わせて曲げない。
 * ページの例が誤っていて実行結果と食い違う場合も、テストは曲げず、そのまま失敗させて報告する。
 *
 * docs/reference/std.*.md の「関数による実装」節のコードは tests/std-functions.test.ts が
 * 別途検証するので、ここには転記しない（形だけを示す断片も対象外）。
 */
import { describe, expect, it } from 'vitest';
import { evaluateYaml, type Value } from '../src/index.js';

interface SpecCase {
  readonly name: string;
  readonly yaml: string;
  readonly input?: Record<string, Value>;
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
    name: 'ハンドラの再利用（本体の閉包を受け取る関数を二つの本体に掛ける）',
    yaml: `
$let:
  fallback:
    $param: run
    $fn:
      $handler:
        std.fail: {$fn: 0}
      $in: {$.run: null}
$in:
  a:
    $handler: \${fallback}
    $in: {$std.lookup: {in: {}, key: missing}}
  b:
    $handler: \${fallback}
    $in: 7
`,
    expected: { a: 0, b: 7 },
  },
  {
    name: 'ローカル作用の宣言（打ち切り：caught boom）',
    yaml: `
$handler:
  throw:
    $param: msg
    $fn: caught \${msg}
$in:
  $do:
  - {$.throw: boom}
  - never
`,
    expected: 'caught boom',
  },
  {
    name: 'ローカル作用の宣言（入れ子のハンドラは同じ名前でも取り違えない）',
    yaml: `
$handler:
  throw:
    $param: m
    $fn:
      $resume: outer \${m}
$in:
  $do:
  - $let:
      up: \${throw}
  - $handler:
      throw:
        $param: m
        $fn:
          $resume: inner \${m}
    a: {$.throw: x}
    b: {$.up: y}
`,
    expected: { a: 'inner x', b: 'outer y' },
  },
  {
    name: 'std.collect の基本形（各要素を二重にする）',
    yaml: `
$std.collect:
  in: [1, 2, 3]
  with:
    $param: x
    $fn:
    - \${x}
    - \${x}
`,
    expected: [1, 1, 2, 2, 3, 3],
  },
  {
    name: '選択の基本形（18 要素版：$in の本体が $std.each）',
    yaml: `
$handler: \${std.list}
$for:
  x: [a, b, c]
  y: [x, y, z]
$in:
  $std.each:
  - \${x}
  - \${y}
`,
    expected: ['a', 'x', 'a', 'y', 'a', 'z', 'b', 'x', 'b', 'y', 'b', 'z', 'c', 'x', 'c', 'y', 'c', 'z'],
  },
  {
    name: '選択の基本形（9 ペア版：$in の本体が literal なリスト）',
    yaml: `
$handler: \${std.list}
$for:
  x: [a, b, c]
  y: [x, y, z]
$in:
- \${x}
- \${y}
`,
    expected: [
      ['a', 'x'], ['a', 'y'], ['a', 'z'],
      ['b', 'x'], ['b', 'y'], ['b', 'z'],
      ['c', 'x'], ['c', 'y'], ['c', 'z'],
    ],
  },
  {
    name: '打ち切りつきの選択（$for と $std.where によるリスト内包表記）',
    yaml: `
$do:
- $handler: \${std.list}
- $for:
    x: [1, 2, 3]
    y: [1, 2, 3]
- $std.where: \${x < y}
- - \${x}
  - \${y}
`,
    expected: [[1, 2], [1, 3], [2, 3]],
  },
  {
    name: '選択の束縛（$let の表を $for で組み替える）',
    yaml: `
$let:
  forms:
    "a{id}": [x, y]
    "b{id}": [z]
$handler: \${std.mapping}
$for:
  entry: \${forms}
  label: \${entry.value}
key: \${label}
value:
  id: \${entry.key}
`,
    expected: { x: { id: 'a{id}' }, y: { id: 'a{id}' }, z: { id: 'b{id}' } },
    expectedKeyOrder: ['x', 'y', 'z'],
  },
  {
    name: 'パラメータと条件分岐',
    yaml: `
server:
  host: {$std.input: db_host}
  port: {$std.input: db_port, $default: 5432}
  tls:
    $if: {$std.input: use_tls}
    $then:
      cert: /etc/ssl/cert.pem
    $else: null
`,
    input: { db_host: 'example.com', use_tls: false },
    expected: { server: { host: 'example.com', port: 5432, tls: null } },
  },
  {
    name: '分岐を貫く状態（連番の採番）',
    yaml: `
$do:
- $handler: \${std.list}
- $std.set: {n: 0}
- $for:
    name: [web, db, cache]
- $let:
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
$handler: \${std.mapping}
$for:
  e: {web: 80, db: 5432}
key: svc-\${e.key}
value: \${e.value}
`,
    expected: { 'svc-web': 80, 'svc-db': 5432 },
    expectedKeyOrder: ['svc-web', 'svc-db'],
  },
  {
    name: '欠落するデータの除外（打ち切りの定型）',
    yaml: `
$handler: \${std.list}
$for:
  row:
  - {date: d1, code: c1}
  - {date: d2}
  - {date: d3, code: c3}
date: \${row.date}
code:
  $std.lookup: {in: "\${row}", key: code}
  $default: {$std.where: false}
`,
    expected: [
      { date: 'd1', code: 'c1' },
      { date: 'd3', code: 'c3' },
    ],
  },
  {
    name: '回数つきの unfold（$std.range + $std.collect + $std.state）',
    yaml: `
$handler: {$std.state: {acc: 1}}
$in:
  $std.collect:
    in: {$std.range: 5}
    with:
      $fn:
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
$let:
  double:
    $param: x
    $fn: \${x * 2}
  succ:
    $param: x
    $fn: \${x + 1}
$in:
  $.succ:
    $.double: 20
`,
    expected: 41,
  },
  {
    name: '$param の列と部分適用（先頭の引数だけを与えると残りを待つ閉包になる）',
    yaml: `
$let:
  add:
    $param: [a, b]
    $fn: \${a + b}
  succ:
    $.add: 1
$in:
  $.succ: 41
`,
    expected: 42,
  },
  {
    name: '演算の部分適用（表を固定した照会関数をキーの各分岐に適用する）',
    yaml: `
$handler: \${std.list}
$let:
  codes: {ja: 81, us: 1}
  look:
    $param: [m, k]
    $fn:
      $std.lookup:
        in: \${m}
        key: \${k}
  dial:
    $.look: \${codes}
$for:
  c: [ja, us]
$in:
  $.dial: \${c}
`,
    expected: [81, 1],
  },
  {
    name: '失敗の捕捉（$handler で std.fail を捕まえて既定値に置き換える）',
    yaml: `
port:
  $handler:
    std.fail:
      $param: msg
      $fn:
        $do:
        - $std.log: \${msg}
        - 5432
  $let:
    p: {$std.input: port, $default: 0}
  $if: \${p <= 0 || p > 65535}
  $then:
    $std.fail: invalid port \${p}
  $else: \${p}
`,
    expected: { port: 5432 },
    expectedLogs: ['invalid port 0'],
  },
  {
    name: '引数で調整するハンドラ（カリー化した関数の部分適用を $handler の式に置く）',
    yaml: `
$let:
  orElse:
    $param: [d, run]
    $fn:
      $handler:
        std.fail: {$fn: "\${d}"}
      $in: {$.run: null}
$in:
  a:
    $handler: {$.orElse: 0}
    $in: {$std.lookup: {in: {}, key: missing}}
  b:
    $handler: {$.orElse: 0}
    $in: 7
`,
    expected: { a: 0, b: 7 },
  },
  {
    name: '最初に成功する分岐（std.first、パラメータ未指定で既定値 info）',
    yaml: `
log_level:
  $handler: \${std.first}
  $for:
    v: [{$std.input: log_level, $default: null}, {$std.input: fallback_log_level, $default: null}, info]
  $do:
  - $std.where: \${v != null}
  - \${v}
`,
    expected: { log_level: 'info' },
  },
  {
    name: '$do の文に置いた $handler（残りの文にハンドラを被せる）',
    yaml: `
$do:
- $handler:
    std.fail: {$fn: 0}
- $std.lookup: {in: {}, key: missing}
`,
    expected: 0,
  },
  {
    name: '$do の文に置いた std.state のハンドラ（残りの文に記憶を通す）',
    yaml: `
$do:
- $handler: {$std.state: {n: 0}}
- $std.set: {n: 41}
- $let:
    n: {$std.get: n}
- \${n + 1}
`,
    expected: 42,
  },
  {
    name: '文脈の導入を伴うマッピング（$in を省いた $let）',
    yaml: `
$let:
  registry: ghcr.io/acme
  env: {$std.input: env, $default: dev}
name: api
image: \${registry}/api:\${env}
replicas:
  $if: \${env == 'prod'}
  $then: 3
  $else: 1
`,
    expected: { name: 'api', image: 'ghcr.io/acme/api:dev', replicas: 1 },
  },
  {
    name: '文脈の導入を伴うマッピング（$in を省いた $handler：節が $resume: null で再開する）',
    yaml: `
database:
  $handler:
    std.fail: {$fn: {$resume: null}}
  host: {$std.input: db_host}
  port: {$std.input: db_port}
`,
    input: { db_host: 'db' },
    expected: { database: { host: 'db', port: null } },
  },
  {
    name: '文脈の導入を伴うマッピング（残りが主形：fizzbuzz）',
    yaml: `
$handler: \${std.list}
$for:
  i0: {$std.range: 15}
$let:
  i: \${i0 + 1}
$if: \${i % 15 == 0}
$then: fizzbuzz
$else:
  $if: \${i % 3 == 0}
  $then: fizz
  $else:
    $if: \${i % 5 == 0}
    $then: buzz
    $else: "\${i}"
`,
    expected: [1, 2, 'fizz', 4, 'buzz', 'fizz', 7, 8, 'fizz', 'buzz', 11, 'fizz', 13, 14, 'fizzbuzz'],
  },
  {
    name: '引数で受けた演算の処理（節の名前 .sig で引数の演算に解決する）',
    yaml: `
$let:
  run:
    $param: sig
    $fn:
      $handler:
        .sig:
          $fn: handled
      $in: {$.sig: null}
  outer:
    $handler:
      signal:
        $fn: unreachable
    $in: \${signal}
$in:
  $.run: \${outer}
`,
    expected: 'handled',
  },
];

describe('grammar/examples.md 用例（値の一致）', () => {
  it.each(cases)('$name', async (c) => {
    const logs: Value[] = [];
    const result = await evaluateYaml(c.yaml, {
      input: c.input,
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

describe('grammar/examples.md 用例（そのほかの記述）', () => {
  it('長い名前の演算には、引数を素通しする $param を $let で短い名前に束縛する', async () => {
    const ops = { 'vault.secrets.read': (arg: Value) => `secret:${String(arg)}` };
    const viaLocalName = await evaluateYaml(
      `
$do:
- $let:
    read:
      $param: key
      $fn: {$vault.secrets.read: '\${key}'}
- {$.read: db/password}
`,
      { ops },
    );
    const direct = await evaluateYaml('{$vault.secrets.read: db/password}', { ops });
    expect(viaLocalName).toEqual(direct);
    expect(viaLocalName).toBe('secret:db/password');
  });

  it('失敗を null で埋めたいときは $default: null と書く', async () => {
    await expect(
      evaluateYaml(`
$handler: \${std.list}
$for:
  row:
  - {date: d1, code: c1}
  - {date: d2}
date: \${row.date}
code:
  $std.lookup: {in: "\${row}", key: code}
  $default: null
`),
    ).resolves.toEqual([
      { date: 'd1', code: 'c1' },
      { date: 'd2', code: null },
    ]);
  });

  it('$handler: ${std.list} と {$std.list: {$param: 捨て名, $fn: 本体}} は同じ意味である', async () => {
    const viaHandler = await evaluateYaml(`
$handler: "\${std.list}"
$in:
  $do:
  - $let:
      x: {$std.each: [1, 2, 3]}
  - \${x * 10}
`);
    const viaCall = await evaluateYaml(`
$std.list:
  $fn:
    $do:
    - $let:
        x: {$std.each: [1, 2, 3]}
    - \${x * 10}
`);
    expect(viaHandler).toEqual([10, 20, 30]);
    expect(viaCall).toEqual(viaHandler);
  });

  it('std は普通の束縛なので $let で隠せる（$for の展開も隠した std に従う）', async () => {
    await expect(
      evaluateYaml(`
$handler: \${std.list}
$in:
  $let:
    std: {each: "\${std.each}"}
  $for:
    x: [1, 2]
  $in: \${x}
`),
    ).resolves.toEqual([1, 2]);
  });

  it('theory.md の対応：束縛を持たない $do の文の並びは f >> g >> h である', async () => {
    await expect(evaluateYaml('{$do: [f, g, h]}')).resolves.toBe('h');
  });
});

// -----------------------------------------------------------------------------
// 期待値が「エラーになる」であるもの
// -----------------------------------------------------------------------------
interface ErrorCase {
  readonly name: string;
  readonly yaml: string;
  readonly input?: Record<string, Value>;
  readonly messagePattern: RegExp;
}

const errorCases: readonly ErrorCase[] = [
  {
    name: '本体の閉包を受け取る関数をその閉包の本体の中で再び使うと自己適用として拒まれる',
    yaml: `
$let:
  h:
    $param: run
    $fn:
      $handler:
        std.fail: {$fn: 0}
      $in: {$.run: null}
$in:
  $handler: \${h}
  $in:
    $handler: \${h}
    $in: 1
`,
    messagePattern: /self-application/,
  },
  {
    name: '関数の式で与えた $handler はローカル作用の宣言を持たない',
    yaml: `
$let:
  h:
    $param: run
    $fn:
      $handler:
        throw: {$param: m, $fn: "caught \${m}"}
      $in: {$.run: null}
$in:
  $handler: \${h}
  $in: {$.throw: boom}
`,
    messagePattern: /undefined reference: throw/,
  },
  {
    name: '捕捉されない std.fail は文書全体のエラーになる',
    yaml: `
$do:
- $let:
    p: {$std.input: port, $default: 0}
- $if: \${p <= 0}
  $then:
    $std.fail: invalid port \${p}
  $else: \${p}
`,
    messagePattern: /invalid port 0/,
  },
  {
    name: '閉包が境界の外へ出て文書の値に残るのはエラー',
    yaml: `{$param: x, $fn: '\${x}'}`,
    messagePattern: /function value cannot escape/,
  },
  {
    name: '演算の値が境界の外へ出て文書の値に残るのはエラー',
    yaml: `pick: "\${std.each}"`,
    messagePattern: /operation value cannot escape/,
  },
  {
    name: '関数と演算を == で比較するのはエラー',
    yaml: `
$let:
  f: {$param: x, $fn: "\${x}"}
$in: "\${f == f}"
`,
    messagePattern: /cannot compare a function or operation value/,
  },
  {
    name: '$std.range の引数が自然数でなければエラー',
    yaml: `{$std.range: -1}`,
    messagePattern: /\$std\.range requires a natural number/,
  },
  {
    name: '予約されていないドットなしの $ キーはエラー',
    yaml: `{$each: [1, 2]}`,
    messagePattern: /unreserved \$ key: \$each/,
  },
  {
    name: '$.return の呼び出しは構文の誤り（return は節の名前として予約されている）',
    yaml: `{$.return: 1}`,
    messagePattern: /return is reserved: \$\.return is not callable/,
  },
  {
    name: 'パスの最初の区画がどの束縛にも解決しない参照は評価前に拒まれる',
    yaml: `x: "\${nope}"`,
    messagePattern: /undefined reference: nope/,
  },
  {
    name: '節の本体の外に書いた $resume は構文の誤り',
    yaml: `
$handler:
  std.fail: {$fn: 0}
$in: {$resume: 1}
`,
    messagePattern: /\$resume is only allowed inside a \$handler clause/,
  },
  {
    name: '節の解決先が演算でなければエラー',
    yaml: `
$handler:
  std.list: {$param: x, $fn: 1}
$in: 2
`,
    messagePattern: /\$handler clause 'std\.list' must name an operation/,
  },
];

describe('grammar/examples.md 用例（エラーになる）', () => {
  it.each(errorCases)('$name', async (c) => {
    await expect(evaluateYaml(c.yaml, { input: c.input })).rejects.toThrow(c.messagePattern);
  });
});

// -----------------------------------------------------------------------------
// grammar/order.md 用例：例の文書と、本文が述べる「キーを入れ替えた形」の値。
// 「並びの意味が未定義の場合」の例は値を定めないので転記しない。
// -----------------------------------------------------------------------------
const letOrder = (first: string, second: string): string => `
$handler: {$std.state: {n: 0}}
$in:
  $handler: \${std.list}
  $let:
    ${first}
    ${second}
    _: {$std.set: {n: "\${x}"}}
  $in: \${a}
`;

const orderCases: readonly SpecCase[] = [
  {
    name: '主形の補助キーと $in の位置は意味を持たない',
    yaml: `
$in:
  $else: small
  $if: \${x > 1}
  $then: large
$let:
  x: 2
`,
    expected: 'large',
  },
  {
    name: '$default の位置は意味を持たない',
    yaml: `
$default: 9
$std.input: missing
`,
    expected: 9,
  },
  {
    name: '別々の演算に解決する節どうしの位置は意味を持たない',
    yaml: `
a:
  $handler:
    std.fail: {$fn: failed}
    std.each: {$fn: chose}
  $in: {$std.each: [1]}
b:
  $handler:
    std.each: {$fn: chose}
    std.fail: {$fn: failed}
  $in: {$std.each: [1]}
`,
    expected: { a: 'chose', b: 'chose' },
  },
  {
    name: '$let：std.each より前に書いた右辺は選択の前に一度だけ評価される',
    yaml: letOrder('a: {$std.get: n}', 'x: {$std.each: [1, 2]}'),
    expected: [0, 0],
  },
  {
    name: '$let：std.each より後に書いた右辺は分岐ごとに評価される',
    yaml: letOrder('x: {$std.each: [1, 2]}', 'a: {$std.get: n}'),
    expected: [0, 1],
  },
  {
    name: '$for：先に書いた束縛が外側の選択になる',
    yaml: `
$handler: \${std.list}
$for:
  i: [1, 2]
  j: [a, b]
$in: \${i}\${j}
`,
    expected: ['1a', '1b', '2a', '2b'],
  },
  {
    name: '$for：束縛を入れ替えると分岐の並びが変わる',
    yaml: `
$handler: \${std.list}
$for:
  j: [a, b]
  i: [1, 2]
$in: \${i}\${j}
`,
    expected: ['1a', '2a', '1b', '2b'],
  },
  {
    name: '頭キー：先に書いた $handler が後に書いた $for の選択を処理する',
    yaml: `
$handler: \${std.list}
$for:
  i: [1, 2]
v: \${i}
`,
    expected: [{ v: 1 }, { v: 2 }],
  },
  {
    name: '頭キー：先に書いた $let の束縛は後に書いた $handler の式から見える',
    yaml: `
$let:
  h: \${std.list}
$handler: \${h}
$for:
  i: [1, 2]
$in: \${i}
`,
    expected: [1, 2],
  },
  {
    name: '頭キー：先に書いた $handler のローカル作用の宣言は後に書いた $let の右辺から見える',
    yaml: `
$handler:
  throw: {$param: m, $fn: "caught \${m}"}
$let:
  t: \${throw}
$in: {$.t: boom}
`,
    expected: 'caught boom',
  },
  {
    name: '頭キー：評価したマッピングは頭キーを除いた残りのキーを文書順に保つ',
    yaml: `
z: 1
$let:
  x: 2
a: \${x}
m: 3
`,
    expected: { z: 1, a: 2, m: 3 },
    expectedKeyOrder: ['z', 'a', 'm'],
  },
  {
    name: 'データのマッピング：同じ境界の中では状態の読み書きが書いた順に起きる',
    yaml: `
$handler: {$std.state: {n: 0}}
a: {$std.set: {n: 1}}
b: {$std.get: n}
`,
    expected: { a: null, b: 1 },
    expectedKeyOrder: ['a', 'b'],
  },
  {
    name: 'データのマッピング：読み出しを先に書くと書き込み前の値を読む',
    yaml: `
$handler: {$std.state: {n: 0}}
b: {$std.get: n}
a: {$std.set: {n: 1}}
`,
    expected: { b: 0, a: null },
    expectedKeyOrder: ['b', 'a'],
  },
  {
    name: 'データのマッピング：先に書いたキーが外側の選択になる',
    yaml: `
$handler: \${std.list}
a: {$std.each: [1, 2]}
b: {$std.each: [x, y]}
`,
    expected: [
      { a: 1, b: 'x' },
      { a: 1, b: 'y' },
      { a: 2, b: 'x' },
      { a: 2, b: 'y' },
    ],
  },
  {
    name: 'データのマッピング：キーを入れ替えると b: x の二つの分岐が先に並ぶ',
    yaml: `
$handler: \${std.list}
b: {$std.each: [x, y]}
a: {$std.each: [1, 2]}
`,
    expected: [
      { b: 'x', a: 1 },
      { b: 'x', a: 2 },
      { b: 'y', a: 1 },
      { b: 'y', a: 2 },
    ],
  },
  {
    name: '兄弟の境界：状態を共有しないので値は並びに依存しない',
    yaml: `
b: {$do: [{$std.set: {n: 1}}, {$std.get: n}]}
a: {$do: [{$std.set: {n: 2}}, {$std.get: n}]}
`,
    expected: { b: 1, a: 2 },
  },
  {
    name: '兄弟の境界：ログは文書順に流れる',
    yaml: `
b: {$do: [{$std.log: first}, 1]}
a: {$do: [{$std.log: second}, 2]}
`,
    expected: { b: 1, a: 2 },
    expectedLogs: ['first', 'second'],
  },
  {
    name: 'std.first は文書順で最初に成功したエントリを採る',
    yaml: `
$handler: \${std.first}
$for:
  e: {b: 2, a: 1}
$in: \${e.key}
`,
    expected: 'b',
  },
];

describe('grammar/order.md 用例（値の一致）', () => {
  it.each(orderCases)('$name', async (c) => {
    const logs: Value[] = [];
    const result = await evaluateYaml(c.yaml, { onLog: (v) => logs.push(v) });
    expect(result).toEqual(c.expected);
    if (c.expectedLogs !== undefined) {
      expect(logs).toEqual(c.expectedLogs);
    }
    if (c.expectedKeyOrder !== undefined) {
      expect(Object.keys(result as object)).toEqual(c.expectedKeyOrder);
    }
  });
});

const orderErrorCases: readonly ErrorCase[] = [
  {
    name: '$let：後に書いた束縛は先の右辺から見えない',
    yaml: `{$let: {y: "\${x}", x: 1}, $in: "\${y}"}`,
    messagePattern: /undefined reference: x/,
  },
  {
    name: '頭キー：$for を $handler より先に書くと選択が境界へ達する',
    yaml: `
$for:
  i: [1, 2]
$handler: \${std.list}
v: \${i}
`,
    messagePattern: /unhandled choice/,
  },
  {
    name: '頭キー：後に書いた $let の束縛は先に書いた $handler の式から見えない',
    yaml: `
$handler: \${h}
$let:
  h: \${std.list}
$for:
  i: [1, 2]
$in: \${i}
`,
    messagePattern: /undefined reference: h/,
  },
  {
    name: '兄弟の境界：先に書いた a の失敗が報告される',
    yaml: `
a: {$std.fail: A}
b: {$std.fail: B}
`,
    messagePattern: /failure: A/,
  },
  {
    name: '兄弟の境界：キーを入れ替えると b の失敗が報告される',
    yaml: `
b: {$std.fail: B}
a: {$std.fail: A}
`,
    messagePattern: /failure: B/,
  },
];

describe('grammar/order.md 用例（エラーになる）', () => {
  it.each(orderErrorCases)('$name', async (c) => {
    await expect(evaluateYaml(c.yaml)).rejects.toThrow(c.messagePattern);
  });
});

// -----------------------------------------------------------------------------
// docs/reference/ 用例：カーネル（do / let / if / fn / handler / for / default）と std の
// 各ページの「例」節にある実行可能な用例。
// 期待値・パラメータ・ログはページの記述をそのまま転記する。grammar/examples.md と内容が
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
    name: 'let.md の例（後の束縛から先の束縛を参照し、$in の本体を評価する）',
    yaml: `
$let:
  x: 2
  y: \${x + 1}
$in: \${x * y}
`,
    expected: 6,
  },
  {
    name: 'if.md の例（$std.input の真偽値で分岐する）',
    yaml: `
tls:
  $if: {$std.input: use_tls}
  $then:
    cert: /etc/ssl/cert.pem
  $else: null
`,
    input: { use_tls: false },
    expected: { tls: null },
  },
  {
    name: 'fn.md の例（$param を省いた 0 引数の関数を null で呼ぶ）',
    yaml: `
$do:
- $let:
    greet:
      $fn:
        $do:
        - $std.log: called
        - hello
- {$.greet: null}
`,
    expected: 'hello',
    expectedLogs: ['called'],
  },
  {
    name: 'fn.md の例（引数を使わない節を 0 引数の形で書く）',
    yaml: `
$handler:
  std.fail: {$fn: 0}
$in: {$std.lookup: {in: {}, key: missing}}
`,
    expected: 0,
  },
  {
    name: 'fn.md の例（$let で束縛した関数を $.名前 で呼ぶ）',
    yaml: `
$do:
- $let:
    double:
      $param: x
      $fn: \${x * 2}
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
        $param: x
        $fn: \${x * 2}
- {$.helpers.double: 21}
`,
    expected: 42,
  },
  {
    name: 'fn.md の例（引数名の列の部分適用で表を固定した照会関数を作る）',
    yaml: `
$do:
- $let:
    codes: {ja: 81, us: 1}
    look:
      $param: [m, k]
      $fn:
        $std.lookup:
          in: \${m}
          key: \${k}
- $let:
    dial:
      $.look: \${codes}
- $.dial: ja
`,
    expected: 81,
  },
  {
    name: 'handler.md の例（失敗の捕捉：ログを流して既定値に置き換える）',
    yaml: `
port:
  $handler:
    std.fail:
      $param: msg
      $fn:
        $do:
        - $std.log: \${msg}
        - 5432
  $let:
    p: {$std.input: port, $default: 0}
  $if: \${p <= 0}
  $then:
    $std.fail: invalid port \${p}
  $else: \${p}
`,
    expected: { port: 5432 },
    expectedLogs: ['invalid port 0'],
  },
  {
    name: 'handler.md の例（ログの計装：捕捉して加工してから呼び直す）',
    yaml: `
$handler:
  std.log:
    $param: msg
    $fn:
      $do:
      - $std.log: 'app: \${msg}'
      - {$resume: null}
$do:
- $std.log: hello
- 42
`,
    expected: 42,
    expectedLogs: ['app: hello'],
  },
  {
    name: 'handler.md の例（ローカル作用の宣言：caught boom）',
    yaml: `
$handler:
  throw:
    $param: msg
    $fn: caught \${msg}
$in:
  $do:
  - {$.throw: boom}
  - never
`,
    expected: 'caught boom',
  },
  {
    name: 'handler.md の例（一度作ったハンドラの関数を二つの本体に掛ける）',
    yaml: `
$let:
  fallback:
    $param: run
    $fn:
      $handler:
        std.fail: {$fn: 0}
      $in: {$.run: null}
$in:
  a: {$handler: "\${fallback}", $in: {$std.lookup: {in: {}, key: missing}}}
  b: {$handler: "\${fallback}", $in: 7}
`,
    expected: { a: 0, b: 7 },
  },
  {
    name: 'handler.md の例（節の本体が定義位置の束縛を捕まえる）',
    yaml: `
$let:
  orElse:
    $param: [d, run]
    $fn:
      $handler:
        std.fail: {$fn: "\${d}"}
      $in: {$.run: null}
  zero: {$.orElse: 0}
  empty: {$.orElse: ""}
$in:
  n: {$handler: "\${zero}", $in: {$std.lookup: {in: {}, key: missing}}}
  s: {$handler: "\${empty}", $in: {$std.lookup: {in: {}, key: missing}}}
`,
    expected: { n: 0, s: '' },
  },
  {
    name: 'default.md の例（$default で失敗を既定値に置き換える）',
    yaml: `
$do:
- $let:
    spec: {}
- pre:
    $do: ["\${spec.pre}"]
    $default: ''
`,
    expected: { pre: '' },
  },
  {
    name: 'default.md の例（$default を省かず null を書いて欠落を埋める）',
    yaml: `
$handler: \${std.list}
$for:
  row:
  - {date: d1, code: c1}
  - {date: d2}
  - {date: d3, code: c3}
date: \${row.date}
code:
  $std.lookup: {in: "\${row}", key: code}
  $default: null
`,
    expected: [
      { date: 'd1', code: 'c1' },
      { date: 'd2', code: null },
      { date: 'd3', code: 'c3' },
    ],
  },
  {
    name: 'default.md の例（打ち切りの定型で行ごと削る）',
    yaml: `
$handler: \${std.list}
$for:
  row:
  - {date: d1, code: c1}
  - {date: d2}
  - {date: d3, code: c3}
date: \${row.date}
code:
  $std.lookup: {in: "\${row}", key: code}
  $default: {$std.where: false}
`,
    expected: [
      { date: 'd1', code: 'c1' },
      { date: 'd3', code: 'c3' },
    ],
  },
  // --- std ---------------------------------------------------------------
  {
    name: 'std.collect.md の例（map の形：各要素を二重にする）',
    yaml: `
$std.collect:
  in: [1, 2, 3]
  with:
    $param: x
    $fn:
    - \${x}
    - \${x}
`,
    expected: [1, 1, 2, 2, 3, 3],
  },
  {
    name: 'std.collect.md の例（filter の形：偶数だけを残す）',
    yaml: `
$std.collect:
  in: [1, 2, 3, 4, 5]
  with:
    $param: x
    $fn:
      $if: \${x % 2 == 0}
      $then:
      - \${x}
      $else: []
`,
    expected: [2, 4],
  },
  {
    name: 'std.collect.md の例（エントリの列から into: mapping で組み立てる）',
    yaml: `
$std.collect:
  in:
  - {name: web, value: 80}
  - {name: db, value: 5432}
  with:
    $param: e
    $fn:
    - key: \${e.name}
      value: \${e.value}
  into: mapping
`,
    expected: { web: 80, db: 5432 },
    expectedKeyOrder: ['web', 'db'],
  },
  {
    name: 'std.each.md の例（二重の選択で全組み合わせを作る）',
    yaml: `
$handler: \${std.list}
$in:
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
$handler: \${std.list}
$in:
  $do:
  - $let:
      e: {$std.each: {web: 80, db: 5432}}
  - \${e.key}
`,
    expected: ['web', 'db'],
  },
  {
    name: 'for.md の例（表の組み替え：後の束縛が先の束縛のエントリを見る）',
    yaml: `
$let:
  forms:
    "a{id}": [x, y]
    "b{id}": [z]
$handler: \${std.mapping}
$for:
  entry: \${forms}
  label: \${entry.value}
key: \${label}
value:
  id: \${entry.key}
`,
    expected: { x: { id: 'a{id}' }, y: { id: 'a{id}' }, z: { id: 'b{id}' } },
    expectedKeyOrder: ['x', 'y', 'z'],
  },
  {
    name: 'for.md の例（$do の文に置いて $std.where と並べるリスト内包表記）',
    yaml: `
$handler: \${std.list}
$in:
  $do:
  - $for:
      x: [1, 2, 3]
      y: [1, 2, 3]
  - $std.where: \${x < y}
  - - \${x}
    - \${y}
`,
    expected: [[1, 2], [1, 3], [2, 3]],
  },
  {
    name: 'for.md の例（マッピングのキーに置いて残りのデータを本体にする）',
    yaml: `
$handler: \${std.list}
$in:
  $for:
    x: [1, 2]
  n: \${x}
  sq: \${x * x}
`,
    expected: [
      { n: 1, sq: 1 },
      { n: 2, sq: 4 },
    ],
  },
  {
    name: 'std.where.md の例（リスト内包表記のガード）',
    yaml: `
$handler: \${std.list}
$in:
  $do:
  - $for:
      x: [1, 2, 3]
      y: [1, 2, 3]
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
  $handler: \${std.list}
  $in:
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
    name: 'std.mapping.md の例（svc- マッピングの生成）',
    yaml: `
$handler: \${std.mapping}
$in:
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
    name: 'std.input.md の例（渡されたパラメータと $default）',
    yaml: `
host: {$std.input: db_host}
port: {$std.input: db_port, $default: 5432}
`,
    input: { db_host: 'example.com' },
    expected: { host: 'example.com', port: 5432 },
  },
  {
    name: 'std.range.md の例（自然数を添字のリストに変える）',
    yaml: `{$std.range: 5}`,
    expected: [0, 1, 2, 3, 4],
  },
  {
    name: 'std.range.md の例（回数つきの unfold）',
    yaml: `
$handler: {$std.state: {acc: 1}}
$in:
  $std.collect:
    in: {$std.range: 5}
    with:
      $fn:
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
    name: 'std.lookup.md の例（$default と組み合わせた既定値つきの照会）',
    yaml: `
$do:
- $let:
    overrides: {web: {timeout: 30}, db: {timeout: 60}}
    label: cache
- $std.lookup:
    in: \${overrides}
    key: \${label}
  $default: {}
`,
    expected: {},
  },
  {
    name: 'std.merge.md の例（後のマッピングの値が勝ち、キーの位置は初出）',
    yaml: `
$std.merge:
- {name: api, replicas: 1}
- {replicas: 3}
`,
    expected: { name: 'api', replicas: 3 },
    expectedKeyOrder: ['name', 'replicas'],
  },
  {
    name: 'std.state.md の例（内側の std.state は外の状態に触れない）',
    yaml: `
$do:
- $std.set: {n: 100}
- $let:
    inner:
      $handler: {$std.state: {n: 0}}
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
$handler: {$std.state: {n: 0}}
$in:
  $handler: \${std.list}
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
    expected: ['a10', 'b11'],
  },
  {
    name: 'std.state.md の例（分岐点で分かれる：各分岐が選択時点の状態を引き継ぐ）',
    yaml: `
$handler: \${std.list}
$in:
  $handler: {$std.state: {n: 0}}
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
$handler: \${std.list}
$in:
  $do:
  - $let:
      x: {$std.each: [a, b]}
  - $handler: {$std.state: {n: 0}}
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
$handler: \${std.list}
$in:
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
  $handler: \${std.first}
  $in:
    $do:
    - $let:
        v: {$std.each: [{$std.input: log_level, $default: null}, info]}
    - $std.where: \${v != null}
    - \${v}
`,
    expected: { log_level: 'info' },
  },
  {
    name: 'std.state.md の例（$do の文に置いた std.state のハンドラで選択に記憶を貫流させる）',
    yaml: `
$do:
- $handler: {$std.state: {i: 0}}
- $handler: \${std.list}
  $in:
    $do:
    - $let:
        x: {$std.each: [a, b, c]}
    - $let:
        i: {$std.get: i}
    - $std.set:
        i: \${i + 1}
    - \${i}-\${x}
`,
    expected: ['0-a', '1-b', '2-c'],
  },
];

describe('docs/reference/ 用例（値の一致）', () => {
  it.each(referenceCases)('$name', async (c) => {
    const logs: Value[] = [];
    const result = await evaluateYaml(c.yaml, {
      input: c.input,
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
    p: {$std.input: port, $default: 0}
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
    await expect(evaluateYaml(c.yaml, { input: c.input })).rejects.toThrow(c.messagePattern);
  });
});
