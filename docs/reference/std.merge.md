# std.merge

`std.merge` は複数のマッピングを一つに重ねる（浅いマージ）。

- 種別：std の関数
- 作用集合への寄与：引数の式の作用だけ。展開内の選択は `std.mapping` が、照会の欠落は `$default` が処理し尽くすので、`std.fail` も含めて境界に現れない。`std.merge` 自身は演算ではないので、ハンドラの節の名前にならない

## 形

```yaml
$std.merge: マッピングのリストの式
```

## 規則

- 同じキーは後のマッピングの値が勝ち、キーの位置は初出の位置が保たれる。
- マージは浅い。値がともにマッピングでも再帰せず、後の値がそのまま採られる。入れ子の階層まで重ねたいときは、その階層に別途 `std.merge` を書く（最後の例）。
- null は普通の値として上書きする。キーの削除はマージの仕事ではなく、`std.mapping` と `std.where` の省略の慣用で行う。
- 空のリストは `{}` になる。マージは結合的で単位は `{}` であり、この性質はキーの並びを含めて成り立つ。
- 引数がリストでないことと、要素がマッピングでないことは、データの変動ではなく形の誤りなのでエラーになる。捕捉できない。
- `std.mapping` がキーの重複をエラーにするのとは矛盾しない。あちらは新しいマッピングの構成であり重複は誤りの兆候、こちらは重複を優先順位で解決することが目的だからである。
- 実装は直接のマージで最適化してよいが、観測できる振る舞いは下の展開と一致する。

## 展開と関数による実装

意味は二項のマージの左畳み込みで定める。
`[m1, ..., mn]` は `{}` から始めて m1 から mn までを順に重ねた結果であり、二項の merge(a, b) は関数 `merge2` の本体が定める。
左畳み込み `merge` は、[std.collect](std.collect.md) で要素を回りながら途中結果を [std.state](std.state.md) のセルに持ち回る。
`{$std.merge: 式}` は `merge` をその式の値に適用した形と等価である。

```yaml
$let:
  merge2:
    $fn: [a, b]
    $body:
      $handler: ${std.mapping}
      $in:
        $do:
        - $for:
            phase: [0, 1]
        - $let:
            src:
              $if: ${phase == 0}
              $then: ${a}
              $else: ${b}
        - $for:
            e: ${src}
        - $let:
            fresh:
              $if: ${phase == 0}
              $then: true
              $else:
                $let:
                  _:
                    $std.lookup:
                      in: ${a}
                      key: ${e.key}
                $in: false
                $default: true
        - $std.where: ${fresh}
        - key: ${e.key}
          value:
            $if: ${phase == 0}
            $then:
              $std.lookup:
                in: ${b}
                key: ${e.key}
              $default: ${e.value}
            $else: ${e.value}
  merge:
    $fn: ms
    $body:
      $handler: {$std.state: {acc: {}}}
      $in:
        $do:
        - $std.collect:
            in: ${ms}
            with:
              $fn: m
              $body:
                $do:
                - $let:
                    cur: {$std.get: acc}
                    step: {$.merge2: "${cur}"}
                    next: {$.step: "${m}"}
                - $std.set:
                    acc: ${next}
                - []
        - $std.get: acc
$in:
  $.merge: [{b: 2, a: 1, keep: base}, {b: 9, c: 3}]
```

```yaml
{b: 9, a: 1, keep: base, c: 3}
```

a の側（phase 0）は自分のキーをその位置のまま並べ、b に同じキーが在ればその値で差し替える。
b の側（phase 1）は a に無いキーだけを後ろに足す。
二つの `$for` の入れ子が全エントリを一列に並べ、`std.mapping` が集め直すので、作用集合への寄与は引数の式の作用だけであり、選択が外へ出ることはない。
`merge` の状態のハンドラは自分の `std.get` と `std.set` を処理し尽くすので、これも外へ出ない。

## 例

値は後勝ち、キーの位置は初出。

```yaml
$std.merge: [{b: 2, a: 1, keep: base}, {b: 9, c: 3}]
```

```yaml
{b: 9, a: 1, keep: base, c: 3}
```

`b` は後のマッピングの値 `9` が勝つが、位置は初出（先頭）のまま動かない。`c` は先のマッピングに無いので末尾に足される。

既定値を外部からの上書きで重ねる。フロー形式 `{...}` の中に裸の `${...}` は置けない（YAML 自体の制約）ので、`${...}` を含む箇所はブロック形式で書く。

```yaml
$let:
  defaults: {timeout: 30, retries: 3}
  overrides:
    $std.param: config
    $default: {}
$in:
  $std.merge:
  - ${defaults}
  - ${overrides}
```

```yaml
{timeout: 30, retries: 3}
```

`config` パラメータが渡されなければ `overrides` は `{}` になり、結果は `defaults` のままになる。

マージは浅いので、入れ子のマッピングを重ねたいときは、その階層に明示的に `std.merge` を書く。

```yaml
$let:
  base:
    server: {host: localhost, port: 80, debug: false}
    label: prod
  patch:
    server: {port: 8080}
$in:
  $std.merge:
  - ${base}
  - server:
      $std.merge:
      - ${base.server}
      - ${patch.server}
```

```yaml
{server: {host: localhost, port: 8080, debug: false}, label: prod}
```

外側の `$std.merge` だけに `patch` を渡すと、`server` は `patch.server` にまるごと差し替わり `host` と `debug` が消える。
それを避けるため、`server` の値自身を `base.server` と `patch.server` の `std.merge` で作ってから外側に渡している。

## 関連

- [std.lookup](std.lookup.md)（展開が使う計算したキーの照会）
- [std.mapping](std.mapping.md)（展開が使う、選択をマッピングに集めるハンドラ）
- [std.state](std.state.md)（展開が使う、途中結果の持ち回り）
- [$default](default.md)（展開が使う、照会の欠落の既定値）
