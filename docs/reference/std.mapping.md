# std.mapping

`std.mapping` は選択を処理し、全分岐の結果をマッピングに集める。

- 種別：std の派生ハンドラ
- 処理する演算：`std.each` `std.where`

## 形

```yaml
{$std.mapping: 式}
```

## 規則

- 本体の各分岐の値は、ちょうど `key` と `value` の二つのキーを持つマッピングでなければならない。`key` の値は文字列でなければならない。
- 全分岐の `{key, value}` を文書順に集めたマッピングに評価される。キーの重複はエラーになる。
- 失敗は処理せず、全体の失敗として伝播させる。
- `std.where` で分岐を打ち切れば、条件を満たすエントリだけが残る。これは「null を入れること」と「キーが無いこと」の区別、すなわちキーの条件付き省略を兼ねる。

## 展開との関係

`std.mapping` は [std.list](std.list.md) と同じ骨格の `$handle` 展開を持つ。
`std.each` と `std.where` の節は std.list のものと同型であり、違いは `return` 節と、集めた結果を最終的にマッピングへ組み立てる段だけである。

- `return` 節は、本体が達した `{key, value}` の値を、std.list と同じく `$collect` が連結できる一要素の列に載せる。
- 各分岐が残したエントリの列は、`$collect` の `$into: mapping` によって一つのマッピングに組み立てられる。ちょうど二つのキーを持つこと、`key` が文字列であること、キーが重複しないことの検査は `$collect` 自身の契約に含まれるので、展開のハンドラ側には現れない。

具体的な `$handle` のコードは std.list の展開を土台に導けるが、本ページでは掲載しない。
仕組みを追いたい場合は [std.list](std.list.md) の展開を先に読み、`$into: mapping` の役割は [$collect](collect.md) の規則を参照すること。

## 例

```yaml
$std.mapping:
  $do:
  - $let:
      e: {$std.each: {web: 80, db: 5432}}
  - key: svc-${e.key}
    value: ${e.value}
```

```yaml
svc-web: 80
svc-db: 5432
```

## 関連

- [std.each](std.each.md)（マッピングの分解）
- [std.where](std.where.md)（エントリの条件付き省略）
- [std.list](std.list.md)
- [$collect](collect.md)
