# std.each

`std.each` は要素を一つずつ選ぶ。
list モナドの bind に相当し、包囲する計算を要素の数だけ分岐させる。

- 種別：std の演算
- 作用：選択

## 形

```yaml
{$std.each: リストまたはマッピングの式}
```

## 規則

- 引数を評価した結果がリストなら各要素を、マッピングなら各エントリを `{key: キー, value: 値}` の形で、文書順に一つずつ選ぶ。値は選ばれた要素である。
- それ以外の型はエラーになる。
- `$std.each: ${xs}` のように、データ駆動の反復が書ける。
- 空のリストやマッピングは分岐 0 本を意味し、その分岐は打ち切りになる。`std.where` の打ち切りはこの規則で定まる。
- 演算は `$` 式の引数の中であればどこにでも置ける。`- [1, {$std.each: [a, b]}]` はリストの要素の位置で選択を行うので、包囲するブロック全体が 2 通りに分岐する。
- 選択を値にするのはハンドラである。[std.list](std.list.md)・[std.mapping](std.mapping.md)・[std.first](std.first.md)、または `std.each` の節を持つ [$handler](handler.md) の内側で使う。どのハンドラにも捕まらずに作用境界へ達した選択は `unhandled choice` のエラーになる。
- 選ばれた要素に名前を付けるのは頭 [$for](for.md) であり、`$for: {x: [a, b, c]}` を「a、b、c のそれぞれを x として」と読む。その展開が `$let` の右辺に置いた `x: {$std.each: [a, b, c]}` である。
- `${std.each}` で演算の値を参照して、束縛したり、関数に渡したりできる。別名を経た呼び出しも同じ作用を起こす。

## 例

```yaml
$handler: ${std.list}
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
$handler: ${std.list}
$do:
- $let:
    e: {$std.each: {web: 80, db: 5432}}
- ${e.key}
```

```yaml
[web, db]
```

## 関連

- [$for](for.md)（選択に名前を束縛する頭。`$let` と `$std.each` への展開で定まる導出形）
- [std.where](std.where.md)（空の `$std.each` で分岐を打ち切る関数）
- [std.list](std.list.md)、[std.mapping](std.mapping.md)、[std.first](std.first.md)（選択を処理するハンドラを立てる関数）
- [$handler](handler.md)（`std.each` の節を自分で書く形）
- [std.collect](std.collect.md)（選択ではなく、構造をその場で回る畳み込み）
