# std.mapping

`std.mapping` は本体の閉包を受け取り、選択を処理して、全分岐の `{key, value}` を集めたマッピングに評価される。

- 種別：std の関数（ハンドラを立てる）
- 処理する演算：`std.each`

## 形

```yaml
$handler: ${std.mapping}
$in: 本体の式
```

`$handler` の式が関数なら本体の閉包を渡す呼び出しに展開されるので、この形は `{$std.mapping: {$fn: 捨て名, $body: 本体}}` と同じ意味である（[$handler](handler.md) のハンドラの再利用）。

## 規則

- 本体の各分岐の値は、ちょうど `key` と `value` の二つのキーを持つマッピングでなければならない。`key` の値は文字列でなければならない。
- 全分岐の `{key, value}` を文書順に集めたマッピングに評価される。キーの重複はエラーになる。
- 失敗は処理せず、全体の失敗として伝播させる。
- [std.where](std.where.md) で分岐を打ち切れば、条件を満たすエントリだけが残る。これは「null を入れること」と「キーが無いこと」の区別、すなわちキーの条件付き省略を兼ねる。

## 展開と関数による実装

`std.mapping` の値は [std.list](std.list.md) と [std.collect](std.collect.md) の合成である。

```yaml
$let:
  mapping:
    $fn: run
    $body:
      $std.collect:
        in:
          $handler: ${std.list}
          $in: {$.run: null}
        with:
          $fn: e
          $body:
          - ${e}
        into: mapping
$in:
  $handler: ${mapping}
  $for:
    e: {web: 80, db: 5432}
  key: svc-${e.key}
  value: ${e.value}
```

```yaml
svc-web: 80
svc-db: 5432
```

`std.list` が選択を処理し、全分岐の `{key, value}` を文書順のリストに集める。
`std.collect` は各エントリをそのまま流し、`into: mapping` が一つのマッピングに組み立てる。
エントリの検査（ちょうど二つのキー、`key` は文字列、重複の禁止）は `std.collect` 自身の契約に含まれるので、展開には現れない。

選択を処理するハンドラの骨格を追いたい場合は [std.list](std.list.md) の展開を、組み立ての規則は [std.collect](std.collect.md) を参照すること。

## 例

```yaml
$handler: ${std.mapping}
$for:
  e: {web: 80, db: 5432}
key: svc-${e.key}
value: ${e.value}
```

```yaml
svc-web: 80
svc-db: 5432
```

`$for` でマッピングを分解し、`std.mapping` で組み立て直す形である。
途中に `$std.where` を挟めば、条件を満たすエントリだけを残せる。

## 関連

- [std.each](std.each.md)、[$for](for.md)（マッピングの分解）
- [std.where](std.where.md)（エントリの条件付き省略）
- [std.list](std.list.md)
- [std.collect](std.collect.md)
- [$handler](handler.md)
