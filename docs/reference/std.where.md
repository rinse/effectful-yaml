# std.where

`std.where` は条件を満たさない分岐を打ち切る。
リスト内包表記のガードに相当する。

- 種別：std の関数
- 作用集合への寄与：`std.each`（展開のとおり）

## 形

```yaml
- $std.where: 条件式
```

## 規則

- 条件が真なら値は null である。`$do` の文の位置に置くのがなじむ。
- 条件が偽なら、その分岐は打ち切られて結果に何も残さない（null が残るのではない）。
- 条件は真偽値でなければならない。真偽値への暗黙の変換は行わない。
- 演算ではないのでハンドラの節の名前にならず、`std.where` 自身は捕捉されない。打ち切りを処理するのは、展開に現れる `std.each` を処理する選択のハンドラである。
- 打ち切りは失敗ではない。`std.fail` が全体を失敗させるのに対し、`std.where` は分岐を静かに消す。
- [std.mapping](std.mapping.md) の本体で使えば、条件を満たすエントリだけを持つマッピングが作れる。
- エラー文言は展開先ではなく、利用者が書いた形（`$std.where`）を名乗る。

## 展開と関数による実装

`std.where` の値は次の関数である。
空のリストの `$std.each` が分岐 0 本の選択となり、包囲する選択のその分岐を打ち切る（[std.each](std.each.md) の規則）。
条件は引数として評価されるので、真偽値でなければエラーになる点も組み込みと同じである。

```yaml
$let:
  where:
    $fn: cond
    $body:
      $if: ${cond}
      $then: null
      $else: {$std.each: []}
$in:
  $handler: ${std.list}
  $for:
    x: [1, 2, 3, 4]
  $do:
  - $.where: ${x % 2 == 0}
  - ${x}
```

```yaml
[2, 4]
```

## 例

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

## 関連

- [std.each](std.each.md)（展開が使う選択の演算）
- [$for](for.md)（選択の束縛を導入する頭）
- [std.fail](std.fail.md)（打ち切りと失敗の違い）
- [std.mapping](std.mapping.md)（エントリの条件付き省略）
- [$default](default.md)（`$default: {$std.where: false}` の定型）
- [$if](if.md)（打ち切りでなく値の分岐が必要なとき）
