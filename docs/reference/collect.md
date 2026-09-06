# $collect

`$collect` は畳み込みのカーネル構文である。
構造を先頭から回りながら、要素ごとの結果を一つの構造に組み立てる。

- 種別：カーネル構文（`$let` `$if` `$fn` `$with` と並ぶ）。演算ではなく、作用を起こさない
- 補助キー：`$with` `$into`

## 形

```yaml
$collect: 対象の式
$with: 一引数関数の式
$into: list または mapping   # 省略時 list
```

## 規則

- 対象はリストまたはマッピングでなければならない。マッピングは `{key: キー, value: 値}` のエントリの列として文書順に回る。
- `$with` の関数を各要素に文書順に適用する。関数は要素ごとにリストを返さなければならない。
- `$into: list`（省略時の既定）のとき、全要素の結果リストを文書順に**連結**したリストになる。
- `$into: mapping` のとき、連結した結果リストの各要素は `key` と `value` のちょうど二つのキーを持ち、`key` が文字列であるマッピングでなければならず、全エントリを集めた一つのマッピングになる。キーの重複はエラーである。
- 空の対象の値は、`$into: list` なら空リスト、`$into: mapping` なら空マッピングである。
- `$collect` 自身は作用を起こさず、ハンドラで捕捉できない。作用は対象の式と `$with` の関数本体の作用の合併である（関数呼び出しと同じ規則）。
- 対象が有限である限り適用は有限回なので、`$collect` は停止性を壊さない。

## 位置づけ

`$collect` は圏論の言葉では畳み込み（catamorphism）であり、リストモナドの bind（concatMap）とエントリ列からのマッピング構成を兼ねる。

- **map**：要素を一要素リストで包む関数を `$with` に渡す。
- **filter**：条件で分岐し、除きたい要素で空リストを返す関数を `$with` に渡す。
- **連結**（flatten）：恒等関数（要素をそのまま返す）を `$with` に渡す。
- **fold**：単体の `$collect` では書けないが、[std.state](std.state.md) と組み合わせるとアキュムレータを持ち回れる（[std.range](std.range.md) の unfold の例を参照）。

カーネルの構文のうち反復を担うのはこの `$collect` だけであり、選択を集める [std.list](std.list.md) や [std.mapping](std.mapping.md)、状態を持ち回る [std.state](std.state.md) は、いずれも `$with` とこの `$collect` への展開で定義される。

## 例

各要素を二重にする（map の形）。

```yaml
$collect: [1, 2, 3]
$with:
  $fn: x
  $body:
  - ${x}
  - ${x}
```

```yaml
[1, 1, 2, 2, 3, 3]
```

偶数だけを残す（filter の形）。

```yaml
$collect: [1, 2, 3, 4, 5]
$with:
  $fn: x
  $body:
    $if: ${x % 2 == 0}
    $then:
    - ${x}
    $else: []
```

```yaml
[2, 4]
```

エントリの列からマッピングを組み立てる（`$into: mapping`）。

```yaml
$collect:
- {name: web, value: 80}
- {name: db, value: 5432}
$with:
  $fn: e
  $body:
  - key: ${e.name}
    value: ${e.value}
$into: mapping
```

```yaml
web: 80
db: 5432
```

## 関連

- [std.list](std.list.md)、[std.mapping](std.mapping.md)（選択を `$collect` で集めるハンドラ）
- [std.state](std.state.md)（`$collect` と組み合わせた fold と unfold）
- [std.range](std.range.md)（回数を構造に変えて `$collect` で回す）
- [$fn](fn.md)
- [言語仕様の $collect の節](../grammar.md)
