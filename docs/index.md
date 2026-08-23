# ドキュメント索引

effectful-yaml のドキュメントの索引である。

## 仕様

- [言語仕様（草案 0.5）](grammar.md)：文法と評価モデルの規範。リファレンスの個々のページと食い違う場合はこちらが優先する。
- [理論的背景](theory.md)：規範ではない解説。Moggi の λc・Haskell の do 記法・Koka の直接スタイルとの対応。
- [設計の経緯](history.md)：規範ではない記録。判断の理由と退けた代替案、草案間の変更、今後の課題。

## 利用

- [処理系の利用](usage.md)：TypeScript から評価器を呼び出す API と評価オプション。
- [CLI（eff-yaml）](cli.md)：std の演算だけで文書を評価するコマンド。

## リファレンス

言語が予約するドットなしのキーは 14 個である。
`$then` のような補助キーは、従属する主キーのページで扱う。
これとは別に、`std.` 名前空間の演算と、その上に定義される std の派生ハンドラを主キーごとのページにまとめる。
`std.` 名前空間そのものは予約されているが、`std.each` のような個々の名前は予約キーではなく、演算・導出形・派生ハンドラとして定義された名前である。

### 予約キー：束縛と制御

| キー | ページ | 概要 |
|---|---|---|
| `$let` `$in` | [let.md](reference/let.md) | 束縛と逐次のカーネル構文（bind 相当を兼ねる） |
| `$do` | [do.md](reference/do.md) | 文の並び。`$let` への展開で定まる導出形 |
| `$if` `$then` `$else` | [if.md](reference/if.md) | 条件分岐 |

### 予約キー：関数

| キー | ページ | 概要 |
|---|---|---|
| `$fn` `$body` | [fn.md](reference/fn.md) | 関数値の生成、呼び出しと名前空間 |

### 予約キー：畳み込みとハンドラ

| キー | ページ | 概要 |
|---|---|---|
| `$collect` `$with` `$into` | [collect.md](reference/collect.md) | 畳み込みの構文。構造を回って一つの構造に組み立てる |
| `$handle` `$with` `$resume` | [handle.md](reference/handle.md) | 利用者定義ハンドラ |

### std：作用を起こす演算

| 演算 | 作用 | ページ | 概要 |
|---|---|---|---|
| `std.each` | 選択 | [std.each.md](reference/std.each.md) | 要素を一つずつ選ぶ |
| `std.param` `$default` | パラメータ | [std.param.md](reference/std.param.md) | 起動時パラメータの読み出し |
| `std.get` | 状態 | [std.get.md](reference/std.get.md) | セルの読み出し |
| `std.set` | 状態 | [std.set.md](reference/std.set.md) | セルへの書き込み |
| `std.log` | ログ | [std.log.md](reference/std.log.md) | ログ出力 |
| `std.fail` | 失敗 | [std.fail.md](reference/std.fail.md) | 計算の失敗（データ起因の部分性も同じ作用になる） |

### std：打ち切りの導出形

| 名前 | ページ | 概要 |
|---|---|---|
| `std.where` | [std.where.md](reference/std.where.md) | 分岐の打ち切り。`$if` と空の `$std.each` への展開で定まる導出形であり、演算ではない |

### std：計算したキーの照会

| 演算 | ページ | 概要 |
|---|---|---|
| `std.lookup` | [std.lookup.md](reference/std.lookup.md) | マッピングを計算したキーで引く（意味は選択による照合への展開で定まる） |

### std：マッピングのマージ

| 演算 | ページ | 概要 |
|---|---|---|
| `std.merge` | [std.merge.md](reference/std.merge.md) | 複数のマッピングを一つに重ねる浅いマージ（意味は展開で定まる） |

### std：第一階の演算（作用を起こさない）

| 演算 | ページ | 概要 |
|---|---|---|
| `std.range` | [std.range.md](reference/std.range.md) | 自然数を添字のリストに変える |

### std：派生ハンドラ

| キー | 処理する演算 | ページ | 概要 |
|---|---|---|---|
| `$std.list` | `std.each` | [std.list.md](reference/std.list.md) | 全分岐をリストに集める |
| `$std.mapping` | `std.each` | [std.mapping.md](reference/std.mapping.md) | 全分岐をマッピングに集める |
| `$std.first` | `std.each` `std.fail` | [std.first.md](reference/std.first.md) | 最初に成功した分岐の値 |
| `$std.state` `$in` | `std.get` `std.set` | [std.state.md](reference/std.state.md) | 状態のスコープ |
| `$std.opt` | `std.fail` | [std.opt.md](reference/std.opt.md) | 失敗を既定値（省略時 null）に翻訳する |

派生ハンドラの意味論はすべて `$handle` と `$collect` への展開で定まる。
`std.list.md`、`std.state.md`、`std.opt.md` はその展開をそのまま掲載する。
`std.mapping.md` は `std.list.md` との展開の違いを文章で説明し、`std.first.md` は展開の概形を示す。
