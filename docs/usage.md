# 処理系の利用

effectful-yaml の処理系を TypeScript から呼び出す方法をまとめる。
文書の書き方は[言語仕様](grammar.md)が規範であり、本ページは評価する側の API だけを扱う。

## 入口

入口は `src/index.ts` である。
パッケージは未公開なので、リポジトリ内から相対パスで import する。

- **`evaluateYaml(source, options?)`**：YAML 文字列をパースして評価する。
- **`evaluate(doc, options?)`**：パース済みの JS 値を評価する。パーサーを差し替えたいときはこちらを使う。

どちらも `Promise<Value>` を返す。
Promise なのは、登録演算のホスト関数が非同期でありうるからである。

## 評価オプション

- **`params`**：`$std.param` が読む起動時パラメータ。名前から値へのマッピング。
- **`ops`**：登録演算のハンドラ。名前は `vault.read` のようにドットを含み、値は `(引数) => 値 | Promise<値>` のホスト関数である。`std.` 名前空間は標準演算のためにあるので登録できない。
- **`onLog`**：`$std.log` の値の受け皿。省略すると標準エラー出力に書く。

## 最小の例

```ts
import { evaluateYaml } from './src/index.js';

const value = await evaluateYaml(
  `
server:
  host: {$std.param: db_host}
  port: {$std.param: db_port, $default: 5432}
`,
  { params: { db_host: 'example.com' } },
);
// value: { server: { host: 'example.com', port: 5432 } }
```

## 登録演算とログ

```ts
const logs: unknown[] = [];
const value = await evaluateYaml(
  `
$do:
- $std.log: reading secret
- password: {$vault.read: secret/db}
`,
  {
    ops: { 'vault.read': async (path) => `secret(${String(path)})` },
    onLog: (v) => logs.push(v),
  },
);
// value: { password: 'secret(secret/db)' }、logs: ['reading secret']
```

## エラー

評価の失敗はすべて `EffectfulYamlError` で reject される。

- 言語仕様上のエラー（未定義参照、マッピングでない値のキーの走査、型の不一致など、文書の形の誤り）。捕捉できない。
- 自己適用の拒否：関数値の流れの検査に通らない文書は、評価を始める前に `self-application detected` で拒否される。この検査の失敗位置は評価時の位置と違い、`$` 式の内側へも降りる構文上の位置（例 `config.$let.f`）で報告される。
- ホスト演算への閉包：文書内のどの節にも現れない演算の引数に閉包が流れうる文書は、評価を始める前に `a function value cannot be passed to a host operation` で拒否される。節を持つ演算では、実行時にホストへ渡る直前の引数に同じ検査が働く。
- 未登録演算：既定ハンドラが処理しない演算が `ops` に無い文書は、評価を始める前に拒否される。ただし静的に追跡できない経路（実行時のデータから選んだ関数など）の演算は、実行がそこへ達した時点で同じエラーになる。
- `$std.fail`：文書内のハンドラ（`$handle`、`$std.first`、`$std.opt` など）に捕まらず既定ハンドラへ達すると、`failure: メッセージ` で reject される。存在しないキーと添字、渡されていないパラメータ、未初期化セルの読み出しもこの失敗作用になる。
- 関数値の脱出：閉包が文書の値に残るとエラーになる。

メッセージの末尾には、失敗した値の文書内の位置が `(at server.hosts[2])` の形で付く（`EffectfulYamlError` の `path` にも入る）。
位置はデータのキーと添字だけを連ねたもので、`$` 式の内側では伸びず、文書全体がその位置なら何も付かない。

```ts
import { EffectfulYamlError, evaluateYaml } from './src/index.js';

try {
  await evaluateYaml('{$std.fail: boom}');
} catch (e) {
  // e は EffectfulYamlError、メッセージは 'failure: boom'
}
```

## 結果の値

`Value` は null、真偽値、数値、文字列、配列、マッピング（プレーンオブジェクト）である。
マッピングのキーは文書順を保つ。
ただし JS オブジェクトの仕様上、非負整数に見えるキーだけは文書順より前に数値順で並ぶ。

本ページのコード例は `tests/usage.test.ts` が実行して固定している。
