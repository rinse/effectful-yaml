# std.list

`std.list` は選択を処理し、全分岐の結果をリストに集める。

- 種別：std の派生ハンドラ
- 処理する演算：`std.each`

## 形

```yaml
{$std.list: 式}
```

## 規則

- 本体の全分岐の結果を、文書順（深さ優先）に並べたリストに評価される。
- 本体に選択がなければ、要素 1 のリストになる。値の形をリストに固定したいときにも使える。
- 打ち切られた分岐は要素を残さない。全分岐が打ち切られれば空リストになる。
- 失敗は処理しない。一つの分岐の失敗は全体の失敗として伝播する。
- 選択が残ったまま作用境界に達した場合の既定の振る舞いは、この `$std.list` と同じである。明示の `$std.list` は、処理する範囲を狭めたいときと形を固定したいときに書く。

## 展開

`$std.list` はカーネルの構文ではなく、`$handle` と `$collect` への次の展開で意味論が定まる。
実装は等価な組み込みで最適化してよいが、観測できる振る舞い（値、作用、ログの順序）はこの展開と一致しなければならない。

```yaml
$handle: 本体
$with:
  std.each:
    $fn: xs
    $body:
      $collect: ${xs}
      $with:
        $fn: x
        $body:
          $resume: ${x}
  return:
    $fn: x
    $body:
    - ${x}
```

ハンドラは深いので、各 `$resume` の値は残りの計算を同じハンドラで処理し尽くしたリストであり、`$collect` がそれらを連結する。
`std.each` の節は `$collect` で候補を回り、各候補について `$with` 関数（節の本体が作った閉包）の中で `$resume: ${x}` を呼ぶ。
この呼び出しは、[$handle](handle.md) が定める「節の中の閉包から `$resume` を呼べる」規則の具体例である。
[$std.where](std.where.md) の打ち切りは、展開により空の `$std.each` として現れ、`std.each` の節が 0 個の候補を畳んで空リストを返すので、専用の節は要らない。
`return` 節は、本体が演算を起こさず値 `x` に達した末端を要素 1 のリスト `[x]` に包む。
内側に選択がなければ `return` 節だけが働き、全体は要素 1 のリストになる。
分岐の中の失敗は `std.fail` の節がないので処理されず、そのまま外側へ伝播して全体の失敗になる。

## 例

```yaml
sizes:
  $std.list:
    $do:
    - $let:
        n: {$std.each: [1, 2, 3]}
    - ${n * 10}
```

```yaml
sizes: [10, 20, 30]
```

## 関連

- [std.mapping](std.mapping.md)（リストでなくマッピングに集める）
- [std.first](std.first.md)（全分岐でなく最初の成功だけが要るとき）
- [std.each](std.each.md)、[std.where](std.where.md)
- [std.state](std.state.md)（選択と状態の関係）
- [$handle](handle.md)、[$collect](collect.md)（展開が使う機構）
