# 処理系の利用

effectful-yaml の処理系を TypeScript から呼び出す方法をまとめる。
文書の書き方は[言語仕様](grammar.md)が規範であり、本ページは評価する側の API だけを扱う。

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

## 登録演算の失敗

ホスト関数は、値を返す代わりに `OperationFailure` を投げてデータ起因の失敗を通知できる。
処理系はこれを演算の呼び出し位置で起きた `std.fail`（値はコンストラクタに渡した値）として扱うので、文書側の `$std.opt` や `std.fail` の節を持つ `$with` で捕捉できる。
捕捉されなければ `failure: メッセージ` で reject される。
`OperationFailure` 以外の例外は捕捉できないエラーであり、失敗位置を添えてそのまま reject される。

```ts
import { evaluateYaml, OperationFailure } from './src/index.js';

const hosts: Record<string, string> = { db: '10.0.0.5' };
const value = await evaluateYaml(
  `
db: {$dns.lookup: db}
cache:
  $std.opt: {$dns.lookup: cache}
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

- 言語仕様上のエラー（未定義参照、マッピングでない値のキーの走査、型の不一致など、文書の形の誤り）。捕捉できない。
- 自己適用の拒否：関数値の流れの検査に通らない文書は、評価を始める前に `self-application detected` で拒否される。この検査は、`$` キーを含めて文書の構文をそのまま降りる構文パス（例 `config.$let.f`）で位置を報告する。
- ホスト演算への閉包：文書内のどの節にも現れない演算の引数に閉包が流れうる文書は、評価を始める前に `a function value cannot be passed to a host operation` で拒否される。節を持つ演算では、実行時にホストへ渡る直前の引数に同じ検査が働く。
- `return` の予約：レキシカルな呼び出し `$.return`（`$.return.x` を含む）を書いた文書は、評価を始める前に `return is reserved: $.return is not callable` で拒否される。`return` はハンドラの節名として予約されているので、この呼び出しは解決しない。`$let` で `return` に束縛することと `${return}` の参照は妨げない。
- 未登録演算：既定ハンドラが処理せず、文書内のどのハンドラの節にも現れず、`ops` にも無い演算を含む文書は、評価を始める前に `unregistered operation: $名前` で拒否される。この検査は演算の出現に対して全域であり、実行が到達しない位置の演算も、呼び先が実行時に決まる関数の本体の演算も同じく拒否される。節を持つ演算はこの検査を通るので、その節のハンドラの範囲外で呼ばれた場合だけ、実行時に同じエラーになる。
- 境界に達した選択：`std.each` を処理するハンドラ（`$std.list`、`$std.mapping`、`$std.first`、`std.each` の節を持つ `$with`）に捕まらずに作用境界へ達した選択は、`unhandled choice: $std.each reached the boundary without a handler` で reject される。選択を含む計算はいずれかのハンドラで包む。
- `$std.fail`：文書内のハンドラ（`$with`、`$std.first`、`$std.opt` など）に捕まらず既定ハンドラへ達すると、`failure: メッセージ` で reject される。存在しないキーと添字、渡されていないパラメータ、未初期化セルの読み出しもこの失敗作用になる。
- 関数値の脱出：閉包が文書の値に残るとエラーになる。
- ローカル作用の脱出：`$with` のドットなしの節名が宣言したローカル作用は、その素通しの関数がハンドラの外へ持ち出されて呼ばれると、どのハンドラにも捕まらずに境界へ達する。このとき未登録演算ではなく `local effect 'throw' escaped its handler (declared at 宣言位置)` で reject される。宣言位置は、内部の演算名を決めるのに使った構文パスである。

メッセージの末尾には、失敗した値の位置が `(at server.hosts[2])` の形で付く（`EffectfulYamlError` の `path` にも入る）。
位置は出力の値の中でのその値の場所であり、データのキーと添字だけを連ねる。
文書全体がその位置なら何も付かない。

位置が伸びるのは、式の値がそのまま出力の値になる経路をたどる間だけである。
この**素通しの経路**は次で尽きる。

- データのマッピングのキーと、リストの添字。
- `$let` と `$std.state` の `$in` の本体。
- `$do` の最後の文。
- 文脈の導入の本体、すなわち残り。残りがデータならそのキーで、残りが `$if` などの主形ならその形の素通しの経路で位置が伸びる。
- `$if` の `$then` と `$else`。
- `return` の節を持たない `$with` の本体。`$std.opt` の本体もこれにあたる。
- `$std.opt` と `$std.param` の `$default`。失敗したときはその値がそのまま出力の値になる。

それ以外の位置では値の形が出力と対応しないので、位置は伸びない。
束縛の右辺、`$if` の条件、演算と関数の引数、ハンドラの節、`$fn` の本体、`$collect` の対象と関数、`$std.list` と `$std.first` の本体、`return` の節を持つ `$with` の本体がこれにあたる。
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
