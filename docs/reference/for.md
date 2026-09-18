# $for

`$for` は選択の束縛を導入する頭である。
右辺の値の要素を一つずつ選び、選ばれた要素を名前に束縛して本体を評価する。

- 種別：導出形（選択の束縛の頭）
- 作用集合への寄与：`std.each`（展開のとおり）
- 補助キー：`$in`（本体）

## 構文

```yaml
$for:
  x: 式1
  y: 式2
$in: 本体の式
```

## 展開

意味は次の展開で定める。

```
{$for: {x1: 式1, ..., xn: 式n}} ∪ 残り ≡ {$let: {x1: {$std.each: 式1}, ..., xn: {$std.each: 式n}}} ∪ 残り
{$do: [{$for: 束縛}, 残り...]}         ≡ {$for: 束縛, $in: {$do: [残り...]}}
```

各右辺は `std.each` の引数になるので、リストなら各要素を、マッピングなら各エントリを `{key: キー, value: 値}` の形で、文書順に選ぶ（[std.each](std.each.md) の規則）。
展開の `$std.each` は展開先の環境で解決するので、`std` を隠せば `$for` もそれに従う。

## 規則

- `x: [a, b, c]` は「a、b、c のそれぞれを x として」と読める。
- 束縛は `$let` の束縛なので、右辺は文書順に評価され、後の束縛の右辺からは先の束縛を参照できる。二つ以上の束縛は入れ子の反復になる。
- 束縛名にドットは使えない（[$let](let.md) と同じ）。
- 本体は `$in` に書く。`$in` を省いた `{$for: 束縛}` は、`$do` の文としても、マッピングのキーとしても置け、それを置いた並びの残りに束縛を導入する（[言語仕様の文脈の導入の節](../grammar/derived.md)）。
- 残りを持たない `{$for: 束縛}` は `$do` の文の位置でだけ書ける。
- 他の頭と同じマッピングに並べたときの内外は文書順である。`$let` で束縛したデータの要素を `$for` で選ぶので、`$let` を先に書く並びが普通である。
- 右辺が空のリストやマッピングなら分岐 0 本になり、その分岐は打ち切りになる。
- 選択に意味を与えるのは、展開に現れる `std.each` を処理する包囲するハンドラ（[std.list](std.list.md)、[std.mapping](std.mapping.md)、[std.first](std.first.md)、または `std.each` の節を持つ [$handler](handler.md)）であり、そのハンドラの形が値の形を決める。
- エラー文言は展開先ではなく、利用者が書いた形（`$for 'x'`）を名乗る。

## 関数による実装

`$for` は束縛を導入する頭なので、関数にするには本体を、束縛名を引数に取る関数として渡す。
`{$for: {x: 式}, $in: 本体}` は、`{$param: x, $fn: 本体}` を `{$std.each: 式}` の値に適用する形と等価であり、これは list モナドの bind そのものである。
二つ以上の束縛は、この適用の入れ子になる。
ただし同じ `for` を、それに渡す関数の本体の中で再び適用することは、関数値の流れの検査が自己適用として拒む（[$handler](handler.md) のハンドラの再利用と同じ制約）。
入れ子にするには、束縛ごとに値を作る。

```yaml
$let:
  for:
    $param: [xs, body]
    $fn:
      $.body: {$std.each: "${xs}"}
$in:
  $handler: ${std.list}
  $let:
    each12: {$.for: [1, 2]}
  $in:
    $.each12:
      $param: x
      $fn:
        n: ${x}
        sq: ${x * x}
```

```yaml
- n: 1
  sq: 1
- n: 2
  sq: 4
```

## 例

形ごとのレーベルの列を、レーベルごとの形に組み替える。

```yaml
$let:
  forms:
    "a{id}": [x, y]
    "b{id}": [z]
$handler: ${std.mapping}
$for:
  entry: ${forms}
  label: ${entry.value}
key: ${label}
value:
  id: ${entry.key}
```

```yaml
x:
  id: a{id}
y:
  id: a{id}
z:
  id: b{id}
```

`entry` はマッピングのエントリを、`label` はそのエントリの値のリストの要素を選ぶ。

`$do` の文に置けば、残りの文に選択の束縛を導入する。
[std.where](std.where.md) と並べるとリスト内包表記になる。

```yaml
$do:
- $handler: ${std.list}
- $for:
    x: [1, 2, 3]
    y: [1, 2, 3]
- $std.where: ${x < y}
- - ${x}
  - ${y}
```

```yaml
[[1, 2], [1, 3], [2, 3]]
```

マッピングのキーに置けば、残りのデータのキーが本体になる。

```yaml
$handler: ${std.list}
$for:
  x: [1, 2]
n: ${x}
sq: ${x * x}
```

```yaml
- n: 1
  sq: 1
- n: 2
  sq: 4
```

## 引用符

右辺はブロック形式のマッピングに並ぶので、`${...}` をそのまま書ける。

```yaml
$for:
  x: ${xs}
```

展開先を一行のフロー形式で書いた `x: {$std.each: "${xs}"}` は引用符を要する。
フロー文脈のプレーンスカラーが `{` を含められないという YAML 自体の制約による（[言語仕様の参照と式の節](../grammar/expressions.md)）。

## 関連

- [std.each](std.each.md)（展開が使う選択の演算）
- [std.where](std.where.md)（同じく選択に属する導出。分岐の打ち切り）
- [std.list](std.list.md)、[std.mapping](std.mapping.md)、[std.first](std.first.md)（選択を処理するハンドラ）
- [$let](let.md)（展開先の逐次のカーネル構文。同じく `$in` を省いて文脈を導入できる形）
- [$do](do.md)（`$in` を省いた `$for` を置ける文の位置）
- [言語仕様の文脈の導入の節](../grammar/derived.md)
