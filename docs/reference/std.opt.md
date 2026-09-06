# std.opt

`std.opt` は失敗を翻訳する（既定は null、`$default` があればその値）。

- 種別：std の派生ハンドラ
- 処理する演算：`std.fail`
- 補助キー：`$default`

## 形

```yaml
{$std.opt: 式}
```

```yaml
$std.opt: 式
$default: 既定値の式
```

## 規則

- 本体が値に達すればその値になる。
- 本体が `std.fail` を起こせば、その分岐は既定値になる（エラーにはならない）。既定値は `$default` の式の値であり、`$default` を省いたときは null になる。
- `$default` は本体が失敗したときだけ評価され、成功時は評価されず、その中の作用も起きない（`$if` の選ばれない分岐、`$std.param` の `$default` と同じ遅延位置である）。
- 作用の推論は出現主義なので、`$default` の中の演算は評価されない場合でも作用シグネチャに数える。
- 選択は処理しない。`$std.list` などの選択のハンドラと組み合わせて、失敗しうる要素を既定値で埋めたまま選択に残す用途に使う。
- `$default` は値を返す式に限らず、作用を起こす式でもよい。`$default: {$std.where: false}` は失敗を包囲する選択の分岐の打ち切りに変える定型である。

## 展開

`$default` はハンドラの語彙で説明できる（`$std.param` の `$default` と同じ骨格）。

```yaml
# {$std.opt: 式, $default: 既定値の式} の展開。失敗を既定値に変える。
$with:
  std.fail:
    $fn: _
    $body: 既定値の式
$in: 式
```

`std.fail` の節が `$resume` を呼ばずに既定値の式へ達するので、失敗した時点で本体は打ち切られ、既定値がハンドラ全体の値になる。
`$default` を省いた `{$std.opt: 式}` は `$default: null` と等価であり、この展開の `$body` が `null` になる。

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
行そのものを削りたいときは、`$default` に `{$std.where: false}` を置く（最後の例）。

`$default` を添えると、null 以外の既定値でパスアクセスの欠落を埋められる。
フロー形式 `{...}` の中に裸の `${...}` は置けない（YAML 自体の制約）ので、`${...}` を含むときはブロック形式で書く。

```yaml
$do:
- $let:
    spec: {}
- pre:
    $std.opt: ${spec.pre}
    $default: ''
```

```yaml
pre: ''
```

`spec` に `pre` が無いので、パスアクセス `${spec.pre}` が `std.fail` を起こし、`$std.opt` がそれを空文字列に翻訳する。

`$default` に `{$std.where: false}` を置くと、失敗した分岐を包囲する選択から黙って外せる。
展開では `$default` の式が `std.fail` の節の本体になるので、その打ち切り（`$std.where` の展開が起こす `std.each`）はこの `$std.opt` 自身ではなく外側で処理され（[$with](with.md) の規則）、包囲する選択の分岐ごと打ち切られる。
打ち切りは選択なので、この形は選択のハンドラの内側で使う。

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
      $default: {$std.where: false}
```

```yaml
- {date: d1, code: c1}
- {date: d3, code: c3}
```

2 行目の分岐は、`code` の欠落を持つ行ごと結果から消える。

## 関連

- [std.fail](std.fail.md)
- [std.param](std.param.md)（`$default` の先行例。同じ遅延位置に従う）
- [std.where](std.where.md)（`$default: {$std.where: false}` の定型で分岐の打ち切りに使う）
- [$with](with.md)
