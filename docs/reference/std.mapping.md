# std.mapping

`std.mapping` は選択を処理し、全分岐の結果をマッピングに集める。

- 種別：std の派生ハンドラ
- 処理する演算：`std.each`

## 形

```yaml
{$std.mapping: 式}
```

## 規則

- 本体の各分岐の値は、ちょうど `key` と `value` の二つのキーを持つマッピングでなければならない。`key` の値は文字列でなければならない。
- 全分岐の `{key, value}` を文書順に集めたマッピングに評価される。キーの重複はエラーになる。
- 失敗は処理せず、全体の失敗として伝播させる。
- `$std.where` で分岐を打ち切れば、条件を満たすエントリだけが残る。これは「null を入れること」と「キーが無いこと」の区別、すなわちキーの条件付き省略を兼ねる。

## 展開との関係

`std.mapping` は [std.list](std.list.md) と [$collect](collect.md) の合成である。

```yaml
$collect:
  $std.list: 式
$with:
  $fn: e
  $body:
  - ${e}
$into: mapping
```

- `$std.list` が選択を処理し、全分岐の `{key, value}` を文書順のリストに集める。
- `$collect` は各エントリをそのまま流し、`$into: mapping` が一つのマッピングに組み立てる。ちょうど二つのキーを持つこと、`key` が文字列であること、キーが重複しないことの検査は `$collect` 自身の契約に含まれるので、展開には現れない。

選択を処理する `$handle` の骨格を追いたい場合は [std.list](std.list.md) の展開を、組み立ての規則は [$collect](collect.md) を参照すること。

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
