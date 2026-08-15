/**
 * 受け入れテスト：ドキュメントに書かれた用例が、そのままの入力・パラメータで
 * ドキュメントに明記された結果になることを独立に検証する。
 *
 * 対象：
 * - docs/grammar.md の「用例」節（10 例）
 * - docs/reference/*.md（全 18 ページ）の「例」節
 *
 * 期待値はドキュメントの記述をそのまま転記する。実装の挙動に合わせて曲げない。
 */
import { describe, expect, it } from 'vitest';
import { evaluateYaml, type Value } from '../src/index.js';

interface SpecCase {
  readonly file: string;
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
  // -------------------------------------------------------------------------
  // docs/grammar.md の「用例」節
  // -------------------------------------------------------------------------
  {
    file: 'grammar.md',
    name: '値だけの文書',
    yaml: `greeting: hello`,
    expected: { greeting: 'hello' },
  },
  {
    file: 'grammar.md',
    name: '選択の基本形（18 要素版：末尾が $each）',
    yaml: `
$do:
- $let:
    x: {$each: [a, b, c]}
    y: {$each: [x, y, z]}
- $each:
  - \${x}
  - \${y}
`,
    expected: ['a', 'x', 'a', 'y', 'a', 'z', 'b', 'x', 'b', 'y', 'b', 'z', 'c', 'x', 'c', 'y', 'c', 'z'],
  },
  {
    file: 'grammar.md',
    name: '選択の基本形（9 ペア版：末尾が literal なリスト）',
    yaml: `
$do:
- $let:
    x: {$each: [a, b, c]}
    y: {$each: [x, y, z]}
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
    file: 'grammar.md',
    name: '打ち切りつきの選択（$where によるリスト内包表記）',
    yaml: `
$do:
- $let:
    x: {$each: [1, 2, 3]}
    y: {$each: [1, 2, 3]}
- $where: \${x < y}
- - \${x}
  - \${y}
`,
    expected: [[1, 2], [1, 3], [2, 3]],
  },
  {
    file: 'grammar.md',
    name: 'パラメータと条件分岐',
    yaml: `
server:
  host: {$param: db_host}
  port: {$param: db_port, $default: 5432}
  tls:
    $if: {$param: use_tls}
    $then:
      cert: /etc/ssl/cert.pem
    $else: null
`,
    params: { db_host: 'example.com', use_tls: false },
    expected: { server: { host: 'example.com', port: 5432, tls: null } },
  },
  {
    file: 'grammar.md',
    name: '分岐を貫く状態（連番の採番）',
    yaml: `
$do:
- $set: {n: 0}
- $let:
    name: {$each: [web, db, cache]}
    id: {$get: n}
- $set:
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
    file: 'grammar.md',
    name: 'マッピングの生成と変換',
    yaml: `
$mapping:
  $do:
  - $let:
      e: {$each: {web: 80, db: 5432}}
  - key: svc-\${e.key}
    value: \${e.value}
`,
    expected: { 'svc-web': 80, 'svc-db': 5432 },
    expectedKeyOrder: ['svc-web', 'svc-db'],
  },
  {
    file: 'grammar.md',
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
    file: 'grammar.md',
    name: '失敗の捕捉（$handle で fail を捕まえて既定値に置き換える）',
    yaml: `
port:
  $handle:
    $do:
    - $let:
        p: {$param: port, $default: 0}
    - $if: \${p <= 0 || p > 65535}
      $then:
        $fail: invalid port \${p}
      $else: \${p}
  $with:
    fail:
      $fn: msg
      $body:
        $do:
        - $log: \${msg}
        - 5432
`,
    expected: { port: 5432 },
    expectedLogs: ['invalid port 0'],
  },
  {
    file: 'grammar.md',
    name: '最初に成功する分岐（$first、パラメータ未指定で既定値 info）',
    yaml: `
log_level:
  $first:
    $do:
    - $let:
        v: {$each: [{$param: log_level, $default: null}, {$param: fallback_log_level, $default: null}, info]}
    - $where: \${v != null}
    - \${v}
`,
    expected: { log_level: 'info' },
  },

  // -------------------------------------------------------------------------
  // docs/reference/do.md
  // -------------------------------------------------------------------------
  {
    file: 'reference/do.md',
    name: '$do は最後の文の値になる',
    yaml: `
$do:
- $log: starting
- hello, world
`,
    expected: 'hello, world',
  },

  // -------------------------------------------------------------------------
  // docs/reference/each.md
  // -------------------------------------------------------------------------
  {
    file: 'reference/each.md',
    name: '$each はリストの要素を一つずつ選ぶ',
    yaml: `
$do:
- $let:
    x: {$each: [1, 2]}
    y: {$each: [10, 20]}
- \${x + y}
`,
    expected: [11, 21, 12, 22],
  },
  {
    file: 'reference/each.md',
    name: '$each はマッピングを {key, value} に分解する',
    yaml: `
$do:
- $let:
    e: {$each: {web: 80, db: 5432}}
- \${e.key}
`,
    expected: ['web', 'db'],
  },

  // -------------------------------------------------------------------------
  // docs/reference/first.md
  // -------------------------------------------------------------------------
  {
    file: 'reference/first.md',
    name: '$first はパラメータ未指定なら既定値 info を選ぶ',
    yaml: `
log_level:
  $first:
    $do:
    - $let:
        v: {$each: [{$param: log_level, $default: null}, info]}
    - $where: \${v != null}
    - \${v}
`,
    expected: { log_level: 'info' },
  },

  // -------------------------------------------------------------------------
  // docs/reference/fn.md
  // -------------------------------------------------------------------------
  {
    file: 'reference/fn.md',
    name: '$fn で作った閉包を $.名前 で呼ぶ',
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
    file: 'reference/fn.md',
    name: 'マッピングに入れた閉包を $.名前.名前 のパスで呼ぶ',
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

  // -------------------------------------------------------------------------
  // docs/reference/get.md
  // -------------------------------------------------------------------------
  {
    file: 'reference/get.md',
    name: '$get はセルの現在値を読む',
    yaml: `
$do:
- $set: {n: 41}
- $let:
    v: {$get: n}
- \${v + 1}
`,
    expected: 42,
  },

  // -------------------------------------------------------------------------
  // docs/reference/handle.md
  // -------------------------------------------------------------------------
  {
    file: 'reference/handle.md',
    name: '失敗の捕捉：fail 節でログを流し既定値に置き換える',
    yaml: `
port:
  $handle:
    $do:
    - $let:
        p: {$param: port, $default: 0}
    - $if: \${p <= 0}
      $then:
        $fail: invalid port \${p}
      $else: \${p}
  $with:
    fail:
      $fn: msg
      $body:
        $do:
        - $log: \${msg}
        - 5432
`,
    expected: { port: 5432 },
    expectedLogs: ['invalid port 0'],
  },
  {
    file: 'reference/handle.md',
    name: 'ログの計装：log 節を捕捉して転送し $resume で継続する',
    yaml: `
$handle:
  $do:
  - $log: hello
  - 42
$with:
  log:
    $fn: msg
    $body:
      $do:
      - $log: 'app: \${msg}'
      - {$resume: null}
`,
    expected: 42,
    expectedLogs: ['app: hello'],
  },
  {
    file: 'reference/handle.md',
    name: '$list の自作：each 節を複数回 $resume して $list と同じ結果を得る',
    yaml: `
$handle:
  $do:
  - $let:
      x: {$each: [1, 2]}
      y: {$each: [10, 20]}
  - \${x + y}
$with:
  each:
    $fn: xs
    $body:
      $list:
        $do:
        - $let:
            e:
              $each: \${xs}
            part:
              $resume: \${e}
            r:
              $each: \${part}
        - \${r}
  return:
    $fn: v
    $body:
    - \${v}
`,
    expected: [11, 21, 12, 22],
  },

  // -------------------------------------------------------------------------
  // docs/reference/if.md
  // -------------------------------------------------------------------------
  {
    file: 'reference/if.md',
    name: '$if は条件に応じて片方だけを評価する',
    yaml: `
tls:
  $if: {$param: use_tls}
  $then: {cert: /etc/ssl/cert.pem}
  $else: null
`,
    params: { use_tls: false },
    expected: { tls: null },
  },

  // -------------------------------------------------------------------------
  // docs/reference/let.md
  // -------------------------------------------------------------------------
  {
    file: 'reference/let.md',
    name: '$let は後の束縛から先の束縛を参照できる',
    yaml: `
$do:
- $let:
    x: 2
    y: \${x + 1}
- \${x * y}
`,
    expected: 6,
  },

  // -------------------------------------------------------------------------
  // docs/reference/list.md
  // -------------------------------------------------------------------------
  {
    file: 'reference/list.md',
    name: '$list は全分岐の結果をリストに集める',
    yaml: `
sizes:
  $list:
    $do:
    - $let:
        n: {$each: [1, 2, 3]}
    - \${n * 10}
`,
    expected: { sizes: [10, 20, 30] },
  },

  // -------------------------------------------------------------------------
  // docs/reference/log.md
  // -------------------------------------------------------------------------
  {
    file: 'reference/log.md',
    name: '$log は値をログ出力に流し、文としての値は無視される',
    yaml: `
$do:
- $log: computing
- 42
`,
    expected: 42,
    expectedLogs: ['computing'],
  },

  // -------------------------------------------------------------------------
  // docs/reference/mapping.md
  // -------------------------------------------------------------------------
  {
    file: 'reference/mapping.md',
    name: '$mapping は $each で分解したエントリをマッピングへ組み立て直す',
    yaml: `
$mapping:
  $do:
  - $let:
      e: {$each: {web: 80, db: 5432}}
  - key: svc-\${e.key}
    value: \${e.value}
`,
    expected: { 'svc-web': 80, 'svc-db': 5432 },
    expectedKeyOrder: ['svc-web', 'svc-db'],
  },

  // -------------------------------------------------------------------------
  // docs/reference/op.md
  // -------------------------------------------------------------------------
  {
    file: 'reference/op.md',
    name: '$op は登録演算を関数値として参照する（$let で短いローカル名を付ける）',
    // ドキュメントは「vault.secrets.read が登録されていれば、直接呼ぶのと同じ意味になる」
    // とだけ述べ、具体的な戻り値は示していない。ここでは戻り値を確認できるモック演算を
    // 登録し、$.read 経由の呼び出しが実際に registered op を同じ引数で呼ぶことを検証する。
    yaml: `
$do:
- $let:
    read: {$op: vault.secrets.read}
- {$.read: db/password}
`,
    ops: { 'vault.secrets.read': (arg) => `secret:${String(arg)}` },
    expected: 'secret:db/password',
  },

  // -------------------------------------------------------------------------
  // docs/reference/param.md
  // -------------------------------------------------------------------------
  {
    file: 'reference/param.md',
    name: '$param は渡されたパラメータを読み、無ければ $default を使う',
    yaml: `
host: {$param: db_host}
port: {$param: db_port, $default: 5432}
`,
    params: { db_host: 'example.com' },
    expected: { host: 'example.com', port: 5432 },
  },

  // -------------------------------------------------------------------------
  // docs/reference/pipe.md
  // -------------------------------------------------------------------------
  {
    file: 'reference/pipe.md',
    name: '$pipe は値を関数の列に順に通す',
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

  // -------------------------------------------------------------------------
  // docs/reference/set.md
  // -------------------------------------------------------------------------
  {
    file: 'reference/set.md',
    name: '$set は複数のセルを一度に書ける',
    yaml: `
$do:
- $set:
    n: 1
    m: 2
- $let:
    a: {$get: n}
    b: {$get: m}
- \${a + b}
`,
    expected: 3,
  },

  // -------------------------------------------------------------------------
  // docs/reference/state.md
  // -------------------------------------------------------------------------
  {
    file: 'reference/state.md',
    name: 'スコープの隔離：内側の $state は外の状態に触れない',
    yaml: `
$do:
- $set: {n: 100}
- $let:
    inner:
      $state: {n: 0}
      $in:
        $do:
        - $set: {n: 1}
        - {$get: n}
    outer: {$get: n}
- inner: \${inner}
  outer: \${outer}
`,
    expected: { inner: 1, outer: 100 },
  },
  {
    file: 'reference/state.md',
    name: '選択との関係：貫流（$state が $list を包む。既定と同じ）',
    yaml: `
$state: {n: 0}
$in:
  $list:
    $do:
    - $set: {n: 10}
    - $let:
        x: {$each: [a, b]}
        i: {$get: n}
    - $set:
        n: \${i + 1}
    - \${x}\${i}
`,
    expected: ['a10', 'b11'],
  },
  {
    file: 'reference/state.md',
    name: '選択との関係：分岐点で分かれる（$list が $state を包む）',
    yaml: `
$list:
  $state: {n: 0}
  $in:
    $do:
    - $set: {n: 10}
    - $let:
        x: {$each: [a, b]}
        i: {$get: n}
    - $set:
        n: \${i + 1}
    - \${x}\${i}
`,
    expected: ['a10', 'b10'],
  },
  {
    // 注意：オーケストレーターの指示では「三つ目（分岐ごとに初期化）はプレースホルダを
    // 含むのでスキップ」とされていたが、docs/reference/state.md の当該例は
    // 「選択を含む本体」のような日本語プレースホルダを含まない完全なプログラムであり、
    // 期待値 [a0, b0] も明記されている（プレースホルダは docs/grammar.md 側の簡略版
    // にのみ存在する）。ドキュメントと実装の独立検証という目的に照らし、実際に完全な
    // プログラムであるこの例を含めた。詳細は報告の「曖昧さ」節を参照。
    file: 'reference/state.md',
    name: '選択との関係：分岐ごとに初期化（$each の後に $state を置く）',
    yaml: `
$do:
- $let:
    x: {$each: [a, b]}
- $state: {n: 0}
  $in:
    $do:
    - $let:
        i: {$get: n}
    - $set:
        n: \${i + 1}
    - \${x}\${i}
`,
    expected: ['a0', 'b0'],
  },
  {
    file: 'reference/state.md',
    name: '連番の採番：貫流を使った例',
    yaml: `
$do:
- $set: {n: 0}
- $let:
    name: {$each: [web, db, cache]}
    id: {$get: n}
- $set:
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

  // -------------------------------------------------------------------------
  // docs/reference/where.md
  // -------------------------------------------------------------------------
  {
    file: 'reference/where.md',
    name: '$where は条件を満たさない分岐を打ち切る',
    yaml: `
$do:
- $let:
    x: {$each: [1, 2, 3]}
    y: {$each: [1, 2, 3]}
- $where: \${x < y}
- - \${x}
  - \${y}
`,
    expected: [[1, 2], [1, 3], [2, 3]],
  },
];

describe('ドキュメント用例（値の一致）', () => {
  it.each(cases)('[$file] $name', async (c) => {
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

it('op.md: $.read 経由の呼び出しは直接 $vault.secrets.read を呼ぶのと同じ値になる', async () => {
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

// -----------------------------------------------------------------------------
// 期待値が「エラーになる」であるもの
// -----------------------------------------------------------------------------
interface ErrorCase {
  readonly file: string;
  readonly name: string;
  readonly yaml: string;
  readonly params?: Record<string, Value>;
  readonly messagePattern: RegExp;
}

const errorCases: readonly ErrorCase[] = [
  {
    file: 'reference/fail.md',
    name: 'port を渡さずに評価すると invalid port 0 で文書全体がエラーになる',
    yaml: `
$do:
- $let:
    p: {$param: port, $default: 0}
- $if: \${p <= 0}
  $then:
    $fail: invalid port \${p}
  $else: \${p}
`,
    messagePattern: /invalid port 0/,
  },
];

describe('ドキュメント用例（エラーになる）', () => {
  it.each(errorCases)('[$file] $name', async (c) => {
    await expect(evaluateYaml(c.yaml, { params: c.params })).rejects.toThrow(c.messagePattern);
  });
});
