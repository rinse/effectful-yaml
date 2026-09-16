# 処理系の利用

effectful-yaml の処理系を TypeScript から呼び出す方法をまとめる。
文書の書き方は[言語仕様](grammar/index.md)が規範であり、本ページは評価する側の API だけを扱う。

## 入口

入口は `src/index.ts` である。
パッケージは npm には公開していない。
`npm link` またはローカルパス依存（`package.json` に `"effectful-yaml": "file:../effectful-yaml"` のように指定する）で導入すれば、他のパッケージからも `import { evaluateYaml } from 'effectful-yaml'` と書ける。
リポジトリ内では `./src/index.js` を相対パスで import してもよい。

- **`evaluateYaml(source, options?)`**：YAML 文字列をパースして評価する。
- **`evaluate(doc, options?)`**：パース済みの JS 値を評価する。パーサーを差し替えたいときはこちらを使う。

どちらも `Promise<Value>` を返す。
Promise なのは、登録演算のホスト関数が非同期でありうるからである。

## 評価オプション

- **`params`**：`$std.param` が読む起動時パラメータ。名前から値へのマッピング。
- **`ops`**：登録演算のハンドラ。名前は `vault.read` のようにドットを含み、値は `(引数) => 値 | Promise<値>` のホスト関数である。呼び出しは作用を起こすので、文書の `$handler` が横取りでき、作用シグネチャに数えられる。`std` は初期環境の束縛のためにあるので、名前の最初の区画に使えない。
- **`functions`**：ホスト関数のハンドラ。形は `ops` と同じ（`{ 'vault.read': impl }`）だが、呼び出しは演算ではなく通常の関数呼び出しになる（`{$vault.read: 引数}`）。`$handler` は横取りできず、作用シグネチャにも現れない。値は `(引数) => 値 | Promise<値>` でよく、非同期でもよい。名前は `ops` と同じくドットを含み、最初の区画に `std` は使えない。同じ名前を `ops` と `functions` の両方に登録するとエラーになる。
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

## 登録演算の失敗

ホスト関数は、値を返す代わりに `OperationFailure` を投げてデータ起因の失敗を通知できる。
処理系はこれを演算の呼び出し位置で起きた `std.fail`（値はコンストラクタに渡した値）として扱うので、文書側の `$default` や `std.fail` の節を持つ `$handler` で捕捉できる。
捕捉されなければ `failure: メッセージ` で reject される。
`OperationFailure` 以外の例外は捕捉できないエラーであり、失敗位置を添えてそのまま reject される。

```ts
import { evaluateYaml, OperationFailure } from './src/index.js';

const hosts: Record<string, string> = { db: '10.0.0.5' };
const value = await evaluateYaml(
  `
db: {$dns.lookup: db}
cache:
  $dns.lookup: cache
  $default: localhost
`,
  {
    ops: {
      'dns.lookup': (name) => {
        const addr = hosts[String(name)];
        if (addr === undefined) throw new OperationFailure(`unknown host: ${String(name)}`);
        return addr;
      },
    },
  },
);
// value: { db: '10.0.0.5', cache: 'localhost' }
```

## エラー

評価の失敗はすべて `EffectfulYamlError` で reject される。

- 言語仕様上のエラー（マッピングでない値のキーの走査、型の不一致など、文書の誤り）。捕捉できない。
- 未定義参照：呼び出しや参照のパスの最初の区画がどの束縛（`$let`・`$fn`、`std`、ホストの `ops`・`functions`、`$handler` のローカル作用の宣言）にも解決しない文書は、評価を始める前に `undefined reference: NAME` で拒否される。環境はレキシカルに決まるので、この判定は評価を要しない。
- 自己適用の拒否：関数値の流れの検査に通らない文書は、評価を始める前に `self-application detected` で拒否される。この検査は、`$` キーを含めて文書の構文をそのまま降りる構文パス（例 `config.$let.f`）で位置を報告する。
- ホストの値への閉包と演算：閉包や演算の値がホストの実装（`ops`・`functions`）の引数に流れうる文書は、評価を始める前に `a function value cannot be passed to a host operation: $名前` で拒否される（ホストの関数なら `host function`）。実行時にも、ホストへ渡る直前の引数に同じ検査が働く。
- `return` の予約：レキシカルな呼び出し `$.return`（`$.return.x` を含む）を書いた文書は、評価を始める前に `return is reserved: $.return is not callable` で拒否される。`return` はハンドラの節名として予約されているので、この呼び出しは解決しない。`$let` で `return` に束縛することと `${return}` の参照は妨げない。
- `$resume` の位置：節の本体の外（`return` 節、ハンドラの本体、`$handler` の外にある関数の本体）に書いた `$resume` は、評価を始める前に `$resume is only allowed inside a $handler clause` で拒否される。
- 境界に達した選択：`std.each` を処理するハンドラ（`$handler: ${std.list}`、`$handler: ${std.mapping}`、`$handler: ${std.first}`、`std.each` の節を持つ `$handler`）に捕まらずに作用境界へ達した選択は、`unhandled choice: $std.each reached the boundary; no enclosing handler handles std.each` で reject される。選択を含む計算はいずれかのハンドラで包む。
- `$std.fail`：文書内のハンドラ（`$handler` の節や `$default`）に捕まらず既定ハンドラへ達すると、`failure: メッセージ` で reject される。存在しないキーと添字、渡されていないパラメータ、未初期化セルの読み出しもこの失敗作用になる。
- `$handler` の式：節のマッピングでも関数でもない値（データや演算）に評価されると、`$handler requires a mapping of clauses or a function, got: 値` で reject される。
- 関数値と演算の値の脱出：閉包が文書の値に残ると `a function value cannot escape into the document value` で、演算の値が残ると `an operation value cannot escape into the document value` で reject される。
- ローカル作用の脱出：`$handler` のドットなしの節名が宣言したローカル作用は、その演算の値がハンドラの外へ持ち出されて呼ばれると、どのハンドラにも捕まらずに境界へ達する。このとき `local effect 'throw' escaped its handler (declared at 宣言位置)` で reject される。宣言位置は、宣言を書いた `$handler` の構文パスである。

メッセージの末尾には、失敗した値の位置が `(at server.hosts[2])` の形で付く（`EffectfulYamlError` の `path` にも入る）。
位置は出力の値の中でのその値の場所であり、データのキーと添字だけを連ねる。
文書全体がその位置なら何も付かない。

位置が伸びるのは、式の値がそのまま出力の値になる経路をたどる間だけである。
この**素通しの経路**は次で尽きる。

- データのマッピングのキーと、リストの添字。
- `$let`・`$for`・節のマッピングを書いた `$handler` の `$in` の本体。
- `$do` の最後の文。
- 文脈の導入の本体、すなわち残り。残りがデータならそのキーで、残りが `$if` などの主形ならその形の素通しの経路で位置が伸びる。
- `$if` の `$then` と `$else`。
- `$default` を添えた式の本体（`$default` を除いた残り）。
- `$default` の式。失敗したときはその値がそのまま出力の値になる。

それ以外の位置では値の形が出力と対応しないので、位置は伸びない。
束縛の右辺、`$if` の条件、演算と関数の引数、ハンドラの節、`$fn` の本体、`std.collect` の対象と関数、関数の式を置いた `$handler`（`$handler: ${std.list}` や `$handler: {$std.state: ...}`）の本体、`return` の節を持つ `$handler` の本体がこれにあたる。
そこで起きた失敗は、それを含む直近の伸びた位置で報告される。
経路は入れ子で伝わるので、伸びない位置の内側にある `$in` の本体も伸びない。

```yaml
$do:
- $std.log: start
- server:
    hosts: [a, {$std.range: x}]
```

`$do` の最後の文はそのまま出力になるので、この文書の失敗位置は `server.hosts[1]` である。

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
