# std.opt

`std.opt` は失敗を null に翻訳する。

- 種別：std の派生ハンドラ
- 処理する演算：`std.fail`

## 形

```yaml
{$std.opt: 式}
```

## 規則

- 本体が値に達すればその値になる。
- 本体が `std.fail` を起こせば、その分岐は null になる（エラーにはならない）。
- 選択は処理しない。`$std.list` などの選択のハンドラと組み合わせて、失敗しうる要素を null で埋めたまま選択に残す用途に使う。

## 展開

```yaml
# $std.opt: 式 の展開。失敗を null に変える。
$handle: 式
$with:
  std.fail:
    $fn: _
    $body: null
```

`std.fail` の節が `$resume` を呼ばずに `null` へ達するので、失敗した時点で本体は打ち切られ、`null` がハンドラ全体の値になる。

## 例

```yaml
$std.list:
  $do:
  - $let:
      row:
        $std.each:
        - {date: d1, code: c1}
        - {date: d2}
        - {date: d3, code: c3}
  - date: ${row.date}
    code:
      $std.opt: ${row.code}
```

```yaml
- {date: d1, code: c1}
- {date: d2, code: null}
- {date: d3, code: c3}
```

2 行目には `code` が無いので、パスアクセス `${row.code}` が `std.fail` を起こし、`$std.opt` がそれを `null` に翻訳する。
行そのものを削りたいときは [std.prune](std.prune.md) を使う。

## 関連

- [std.fail](std.fail.md)
- [std.prune](std.prune.md)（失敗を null でなく打ち切りに変える）
- [$handle](handle.md)
