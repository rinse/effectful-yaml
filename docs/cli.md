# CLI（eyaml）

effectful-yaml 文書をコマンドラインから評価する CLI である。
標準の `$` アクションだけを持ち、登録演算は使えない。
登録演算を使いたい場合は[処理系の利用](usage.md)の API から評価する。

## 使い方

```
eyaml [file] [-p name=value]...
```

- **`file`**：入力の YAML ファイル。省略時と `-` は標準入力から読む。
- **`-p, --param`**：`$param` が読む起動時パラメータ。繰り返し指定できる。
- **`-h, --help`**：ヘルプを表示する。

評価した結果を YAML として標準出力に書く。
`$log` の中身は標準エラー出力に書くので、結果だけをパイプやリダイレクトで受け取れる。
評価に失敗すると終了コード 1 で、メッセージを標準エラー出力に書く。

パラメータの値は YAML として解釈する。
`-p port=5432` は数値になり、文字列にしたければ `-p 'host="5432"'` のように引用する。

## 実行

パッケージは未公開なので、リポジトリ内でビルドして使う。

```
npm run build
echo 'greeting: {$param: name, $default: world}' | node dist/bin.js -p name=CLI
# greeting: CLI
```

`npm link` を実行すると `eyaml` コマンドとして PATH に入る。
Puppet の hiera-eyaml も `eyaml` コマンドを提供するため、衝突する環境では `package.json` の `bin` の名前を変える。

本ページの挙動は `tests/cli.test.ts` が固定している。
