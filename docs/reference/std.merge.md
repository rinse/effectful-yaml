# std.merge

`std.merge` は複数のマッピングを一つに重ねる（浅いマージ）。

- 種別：標準演算
- 作用：引数の式の作用だけ。展開内の選択は `$std.mapping` が、照会の欠落は `$std.opt` が処理し尽くすので、`std.fail` も含めて境界に現れない。`std.merge` という名前自体は作用集合に入らず、ハンドラの節の名前にもならない。

## 形

```yaml
$std.merge: マッピングのリストの式
```

## 規則

- 同じキーは後のマッピングの値が勝ち、キーの位置は初出の位置が保たれる。
- マージは浅い。値がともにマッピングでも再帰せず、後の値がそのまま採られる。入れ子の階層まで重ねたいときは、その階層に別途 `std.merge` を書く（最後の例）。
- null は普通の値として上書きする。キーの削除はマージの仕事ではなく、`$std.mapping` と `$std.where` の省略の慣用で行う。
- 空のリストは `{}` になる。マージは結合的で単位は `{}` であり、この性質はキーの並びを含めて成り立つ。
- 引数がリストでないことと、要素がマッピングでないことは、データの変動ではなく形の誤りなのでエラーになる。捕捉できない。
- `$std.mapping` がキーの重複をエラーにするのとは矛盾しない。あちらは新しいマッピングの構成であり重複は誤りの兆候、こちらは重複を優先順位で解決することが目的だからである。
- 実装は直接のマージで最適化してよいが、観測できる振る舞いは下の展開と一致する。

## 展開

意味は二項のマージの左畳み込みで定める。`[m1, ..., mn]` は `{}` から始めて m1 から mn までを順に重ねた結果であり、二項の merge(a, b) は次の展開で定める。

```yaml
# merge(a, b) の展開。b が勝ち、キーの位置は初出の位置。
$let:
  a: 先の式
  b: 後の式
$in:
  $std.mapping:
    $do:
    - $let:
        phase:
          $std.each: [0, 1]
        src:
          $if: ${phase == 0}
          $then: ${a}
          $else: ${b}
        e:
          $std.each: ${src}
        fresh:
          $if: ${phase == 0}
          $then: true
          $else:
            $std.opt:
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
          $std.opt:
            $std.lookup:
              in: ${b}
              key: ${e.key}
          $default: ${e.value}
        $else: ${e.value}
```

a の側（phase 0）は自分のキーをその位置のまま並べ、b に同じキーが在ればその値で差し替える。
b の側（phase 1）は a に無いキーだけを後ろに足す。
二つの `$std.each` の入れ子が全エントリを一列に並べ、`$std.mapping` が集め直すので、作用集合への寄与は引数の式の作用だけであり、境界の形に影響しない。

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
- [std.mapping](std.mapping.md)（展開が使う、選択をマッピングに集める派生ハンドラ）
- [std.opt](std.opt.md)（展開が使う、照会の欠落を既定値に翻訳する派生ハンドラ）
