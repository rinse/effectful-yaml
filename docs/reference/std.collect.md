# std.collect

`std.collect` は畳み込みである。
構造を先頭から回りながら、要素ごとの結果を一つの構造に組み立てる。

- 種別：std の関数（作用を起こさない）

## 構文

```yaml
$std.collect:
  in: 対象の式
  with: 一引数関数の式
  into: list または mapping   # 省略時 list
```

## 規則

- 対象はリストまたはマッピングでなければならない。マッピングは `{key: キー, value: 値}` のエントリの列として文書順に回る。
- `with` の関数を各要素に文書順に適用する。関数は要素ごとにリストを返さなければならない。
- `into: list`（省略時の既定）のとき、全要素の結果リストを文書順に**連結**したリストになる。
- `into: mapping` のとき、連結した結果リストの各要素は `key` と `value` のちょうど二つのキーを持ち、`key` が文字列であるマッピングでなければならず、全エントリを集めた一つのマッピングになる。キーの重複はエラーである。
- 空の対象の値は、`into: list` なら空リスト、`into: mapping` なら空マッピングである。
- `std.collect` 自身は作用を起こさず、演算ではないのでハンドラで捕捉できない。作用は引数の式と `with` の関数本体の作用の合併である（関数呼び出しと同じ規則）。
- 対象が有限である限り適用は有限回なので、`std.collect` は停止性を壊さない。
- 関数を引数に取るので導出できないが、意味は値から値への規則で定まり、評価器が実装する。
- `with` は処理系が一引数で呼ぶ位置である。引数 2 個以上の `$fn` を書くと閉包が結果の要素になり、多くの場合そのまま関数値の脱出のエラーへ至る（[$fn](fn.md)）。

## 位置づけ

`std.collect` は圏論の言葉では畳み込み（catamorphism）であり、リストモナドの bind（concatMap）とエントリ列からのマッピング構成を兼ねる。
カーネルは畳み込みの構文を持たず、構造を回る反復はこの関数が与える。

- **map**：要素を一要素リストで包む関数を `with` に渡す。
- **filter**：条件で分岐し、除きたい要素で空リストを返す関数を `with` に渡す。
- **連結**（flatten）：恒等関数（要素をそのまま返す）を `with` に渡す。
- **fold**：単体では書けないが、[std.state](std.state.md) と組み合わせるとアキュムレータを持ち回れる（[std.range](std.range.md) の unfold の例を参照）。

選択を集める [std.list](std.list.md) と [std.mapping](std.mapping.md)、状態を持ち回る [std.state](std.state.md) の展開は、いずれもこの関数を使う。

## 例

各要素を二重にする（map の形）。

```yaml
$std.collect:
  in: [1, 2, 3]
  with:
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
$std.collect:
  in: [1, 2, 3, 4, 5]
  with:
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

エントリの列からマッピングを組み立てる（`into: mapping`）。

```yaml
$std.collect:
  in:
  - {name: web, value: 80}
  - {name: db, value: 5432}
  with:
    $fn: e
    $body:
    - key: ${e.name}
      value: ${e.value}
  into: mapping
```

```yaml
web: 80
db: 5432
```

## 関連

- [std.list](std.list.md)、[std.mapping](std.mapping.md)（選択を `std.collect` で集めるハンドラ）
- [std.state](std.state.md)（`std.collect` と組み合わせた fold と unfold）
- [std.range](std.range.md)（回数を構造に変えて回す）
- [$fn](fn.md)
- [$handler](handler.md)（節の中の閉包から `$resume` を呼ぶ規則が、この関数に渡す関数のために要る）
- [言語仕様の std の節](../grammar/std.md)
