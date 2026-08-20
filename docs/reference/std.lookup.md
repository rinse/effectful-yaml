# std.lookup

`std.lookup` はマッピングを計算したキーで引く。

- 種別：標準演算
- 作用：`std.fail`（欠落したキー）と `in` / `key` の式の作用。`std.lookup` という名前自体は作用集合に入らない。

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
- したがって欠落は、パスアクセスの欠落と同じように [std.opt](std.opt.md) や `$handle` で扱える。
- `in` の値がマッピングでないことと `key` の値が文字列でないことは、データの変動ではなく形の誤りなのでエラーになる。捕捉できない。
- 実装は O(1) の照会で最適化してよいが、観測できる振る舞いは下の展開と一致する。

## 展開

意味は選択による照合への展開で定める。

```yaml
# {$std.lookup: {in: m, key: k}} の展開
$do:
- $let:
    m: in の式
    k: key の式
- $std.first:
    $do:
    - $let:
        e:
          $std.each: ${m}
    - $std.where: ${e.key == k}
    - ${e.value}
```

キーが在ればその値になり、無ければ `$std.first` の規則によりこの位置で `std.fail` が起きる。
展開の中の選択は `$std.first` が処理し尽くすので、作用集合への寄与は `std.fail` と `in` / `key` の式の作用だけであり、境界の形（単値かリストか）に影響しない。

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

キーが無ければ `std.fail` が起きるので、[std.opt](std.opt.md) の `$default` と組み合わせて、無ければ空のマッピングにする既定値つきの照会が書ける。
フロー形式 `{...}` の中に裸の `${...}` は置けない（YAML 自体の制約）ので、`${...}` を含む箇所はブロック形式で書く。

```yaml
$do:
- $let:
    overrides: {web: {timeout: 30}, db: {timeout: 60}}
    label: cache
- $std.opt:
    $std.lookup:
      in: ${overrides}
      key: ${label}
  $default: {}
```

```yaml
{}
```

`cache` は `overrides` に無いので `$std.lookup` が `std.fail` を起こし、`$std.opt` がそれを空のマッピングに翻訳する。

## 関連

- [std.opt](std.opt.md)（失敗を既定値に変える）
- [言語仕様の計算したキーの照会](../grammar.md)
