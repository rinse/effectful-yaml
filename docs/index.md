# ドキュメント索引

effectful-yaml のドキュメントの索引である。

## 仕様

- [言語仕様（草案 0.3）](grammar.md)：文法と評価モデルの規範。リファレンスの個々のページと食い違う場合はこちらが優先する。

## 利用

- [処理系の利用](usage.md)：TypeScript から評価器を呼び出す API と評価オプション。
- [CLI（eff-yaml）](cli.md)：標準の `$` アクションだけで文書を評価するコマンド。

## リファレンス

予約キー 26 個を主キーごとのページにまとめる。
`$then` のような補助キーは、従属する主キーのページで扱う。

### 束縛と制御

| キー | ページ | 概要 |
|---|---|---|
| `$do` | [do.md](reference/do.md) | 文の並びの逐次評価 |
| `$let` | [let.md](reference/let.md) | 束縛（bind 相当を兼ねる） |
| `$if` `$then` `$else` | [if.md](reference/if.md) | 条件分岐 |

### 関数

| キー | ページ | 概要 |
|---|---|---|
| `$fn` `$body` | [fn.md](reference/fn.md) | 関数値の生成と呼び出し |
| `$op` | [op.md](reference/op.md) | 演算の関数値化 |
| `$pipe` `$through` | [pipe.md](reference/pipe.md) | Kleisli 合成 |

### 演算

| キー | 作用 | ページ | 概要 |
|---|---|---|---|
| `$each` | 選択 | [each.md](reference/each.md) | 要素を一つずつ選ぶ |
| `$where` | 選択 | [where.md](reference/where.md) | 分岐の打ち切り |
| `$param` `$default` | パラメータ | [param.md](reference/param.md) | 起動時パラメータの読み出し |
| `$get` | 状態 | [get.md](reference/get.md) | セルの読み出し |
| `$set` | 状態 | [set.md](reference/set.md) | セルへの書き込み |
| `$log` | ログ | [log.md](reference/log.md) | ログ出力 |
| `$fail` | 失敗 | [fail.md](reference/fail.md) | 計算の失敗 |

### ハンドラ

| キー | ページ | 概要 |
|---|---|---|
| `$list` | [list.md](reference/list.md) | 全分岐をリストに集める |
| `$mapping` | [mapping.md](reference/mapping.md) | 全分岐をマッピングに集める |
| `$first` | [first.md](reference/first.md) | 最初に成功した分岐の値 |
| `$state` `$in` | [state.md](reference/state.md) | 状態のスコープ |
| `$handle` `$with` `$resume` | [handle.md](reference/handle.md) | 利用者定義ハンドラ |
