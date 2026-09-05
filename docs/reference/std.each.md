# std.each

`std.each` は要素を一つずつ選ぶ。
list モナドの bind に相当し、ブロックを要素の数だけ分岐させる。

- 種別：標準演算
- 作用：選択

## 形

```yaml
{$std.each: リストまたはマッピングの式}
```

## 規則

- 引数を評価した結果がリストなら各要素を、マッピングなら各エントリを `{key: キー, value: 値}` の形で、文書順に一つずつ選ぶ。値は選ばれた要素である。
- それ以外の型はエラーになる。
- `$std.each: ${xs}` のように、データ駆動の反復が書ける。
- 空のリストやマッピングは分岐 0 本を意味し、その分岐は打ち切りになる。`$std.where` の打ち切りはこの規則への展開で定まる。
- 選択を値にするのはハンドラである。`$std.list` `$std.mapping` `$std.first`、または `std.each` の節を持つ `$handle` の内側で使う。どのハンドラにも捕まらずに作用境界へ達した選択はエラーになる。
- 典型的には `$let` の右辺に置き、`x: {$std.each: [a, b, c]}` を「a、b、c のそれぞれを x として」と読む。

## 例

```yaml
$std.list:
  $do:
  - $let:
      x: {$std.each: [1, 2]}
      y: {$std.each: [10, 20]}
  - ${x + y}
```

```yaml
[11, 21, 12, 22]
```

マッピングの分解は次のとおりである。

```yaml
$std.list:
  $do:
  - $let:
      e: {$std.each: {web: 80, db: 5432}}
  - ${e.key}
```

```yaml
[web, db]
```

## 関連

- [std.where](std.where.md)（空の `$std.each` への展開で定まる打ち切り）
- [std.list](std.list.md)、[std.mapping](std.mapping.md)、[std.first](std.first.md)（選択を処理するハンドラ）
- [$collect](collect.md)（選択の展開が使う畳み込みの構文）
