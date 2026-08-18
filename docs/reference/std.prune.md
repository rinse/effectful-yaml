# std.prune

`std.prune` は失敗を、包囲する選択の分岐の打ち切りに翻訳する。

- 種別：std の派生ハンドラ
- 処理する演算：`std.fail`

## 形

```yaml
{$std.prune: 式}
```

## 規則

- 本体が値に達すればその値になる。
- 本体が `std.fail` を起こせば、その分岐は `std.where: false` と同じ打ち切りになる。
- 打ち切りを起こす作用（`std.where`）はこのハンドラ自身ではなく、外側で処理される。したがって打ち切りは `$std.prune` を包む選択のハンドラ（`$std.list` など）にまで届き、その選択の分岐ごと消える。
- 欠落したキーを持つデータを黙って除外する用途に使う標準形である。

## 展開

```yaml
# $std.prune: 式 の展開。失敗を包囲する選択の打ち切りに変える。
$handle: 式
$with:
  std.fail:
    $fn: _
    $body: {$std.where: false}
```

`std.fail` の節の本体が起こす `std.where` は、`$handle` の規則（節の本体が起こす作用は外側で処理される）により、この `$std.prune` 自身ではなく外側のハンドラへ抜ける。
`$resume` を呼ばないので、失敗した時点で本体は打ち切られる。

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
      $std.prune: ${row.code}
```

```yaml
- {date: d1, code: c1}
- {date: d3, code: c3}
```

2 行目には `code` が無いので、パスアクセス `${row.code}` が `std.fail` を起こし、`$std.prune` がそれを分岐の打ち切りに変える。
失敗を null で埋めたいときは [std.opt](std.opt.md) を使う。

## 関連

- [std.fail](std.fail.md)
- [std.opt](std.opt.md)（失敗を打ち切りでなく null に変える）
- [std.where](std.where.md)
- [$handle](handle.md)
