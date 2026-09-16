# std.lookup

`std.lookup` はマッピングを計算したキーで引く。

- 種別：std の関数
- 作用集合への寄与：`std.fail`（欠落したキー）と引数の式の作用。`std.lookup` 自身は演算ではないので、ハンドラの節の名前にならない

## 形

```yaml
$std.lookup:
  in: マッピングの式
  key: キーの式
```

## 規則

- 式のパス `${m.k}` のキーが literal に限られるのに対し、`std.lookup` はキーを式で与えられる。
- `in` のマッピングに `key` の文字列と一致するキーが在れば、その値になる。
- 無ければ、この位置で `std.fail` が起きる。値は欠落したキーを含む説明文であり、式のパスアクセスの文言（`missing key '...'`）に揃えてある。
- したがって欠落は、パスアクセスの欠落と同じように [$default](default.md) や `std.fail` の節を持つ [$handler](handler.md) で扱える。
- `in` の値がマッピングでないことと `key` の値が文字列でないことは、データの変動ではなく形の誤りなのでエラーになる。捕捉できない。
- 引数はマッピング一つなので、表を固定した照会関数を作るには、引数を組み立てるカリー化された関数（adapter）を挟む（[$fn](fn.md) の部分適用）。
- 実装は O(1) の照会で最適化してよいが、観測できる振る舞いは下の展開と一致する。

## 展開と関数による実装

意味は選択による照合への展開で定める。
`std.lookup` の値は次の関数であり、`{$std.lookup: {in: m, key: k}}` はこれを同じ引数で呼んだ形と等価である。

```yaml
$let:
  lookup:
    $fn: arg
    $body:
      $handler: ${std.first}
      $in:
        $do:
        - $for:
            e: ${arg.in}
        - $std.where: ${e.key == arg.key}
        - ${e.value}
$in:
  $let:
    prices: {basic: 9, pro: 29, enterprise: 99}
  $in:
    $.lookup:
      in: ${prices}
      key: pro
```

```yaml
29
```

キーが在ればその値になり、無ければ `std.first` の規則によりこの位置で `std.fail` が起きる。
展開の中の選択は `std.first` が処理し尽くすので、作用集合への寄与は `std.fail` と引数の式の作用だけであり、選択が外へ出ることはない。
失敗の値の文言だけは展開に委ねず、組み込みは欠落したキーを含む説明文にする（規則の節）。
`in` と `key` の形の検査も契約に含め、展開には現れない。

## 例

計算したキーで料金表を引く。

```yaml
$do:
- $let:
    prices: {basic: 9, pro: 29, enterprise: 99}
    plan: pro
- $std.lookup:
    in: ${prices}
    key: ${plan}
```

```yaml
29
```

キーが無ければ `std.fail` が起きるので、[$default](default.md) と組み合わせて既定値つきの照会が書ける。
フロー形式 `{...}` の中に裸の `${...}` は置けない（YAML 自体の制約）ので、`${...}` を含む箇所はブロック形式で書く。

```yaml
$do:
- $let:
    overrides: {web: {timeout: 30}, db: {timeout: 60}}
    label: cache
- $std.lookup:
    in: ${overrides}
    key: ${label}
  $default: {}
```

```yaml
{}
```

`cache` は `overrides` に無いので `std.lookup` が `std.fail` を起こし、`$default` がそれを空のマッピングに置き換える。

## 関連

- [$default](default.md)（欠落を既定値に置き換える）
- [std.first](std.first.md)（展開が使う、最初の成功を採るハンドラ）
- [std.where](std.where.md)、[$for](for.md)（展開が使う照合）
- [$fn](fn.md)（表を固定した照会関数を作る部分適用）
- [言語仕様の std の節](../grammar/std.md)
